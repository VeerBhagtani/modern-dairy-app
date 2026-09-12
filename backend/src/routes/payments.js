/* Razorpay payment intake.
 *
 * This router did not exist. services/razorpayClient.js had a correct
 * verifyWebhookSignature() — constant-time, length-checked — but nothing in
 * the application ever called it, and no /payments route was mounted. The only
 * thing deciding that a payment had happened was the Razorpay checkout widget's
 * success callback in the browser, i.e. the client:
 *
 *     handler: function(){ onSuccess(); }     // www/index.html
 *
 * That is not proof of payment. It is proof that something in the page called a
 * function, which anyone with devtools can do directly.
 *
 * The webhook below is now the ONLY thing that can settle a wallet top-up.
 * Three properties make it trustworthy:
 *   1. The signature is verified over the RAW request bytes. index.js mounts
 *      express.raw() for this path specifically — express.json() would have
 *      already reparsed the body, and re-serialising it does not reliably
 *      reproduce the exact bytes Razorpay signed.
 *   2. Settlement is idempotent on Razorpay's own payment id. Razorpay retries
 *      webhooks, and a retry must credit a balance once, not twice.
 *   3. The credited amount comes from the webhook payload (what Razorpay says
 *      was actually captured), never from anything the client sent.
 */
const router = require('express').Router();
const { col, db, FieldValue } = require('../services/firestore');
const razorpay = require('../services/razorpayClient');

// Razorpay sends amounts in paise.
const toRupees = (paise) => Math.round(Number(paise || 0)) / 100;

router.post('/razorpay/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  // req.body is a Buffer here (see the express.raw mount in index.js).
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

  let valid = false;
  try {
    valid = await razorpay.verifyWebhookSignature(raw, signature);
  } catch (e) {
    console.error('razorpay webhook: signature check failed to run', e.message);
    return res.status(503).json({ success: false, message: 'Cannot verify webhooks right now' });
  }
  if (!valid) {
    // Deliberately terse: an attacker probing this endpoint learns nothing
    // about why their forgery was rejected.
    return res.status(400).json({ success: false, message: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ success: false, message: 'Malformed payload' }); }

  // Only a captured payment moves money. 'authorized' is not captured, and
  // 'failed' obviously is not.
  if (event.event !== 'payment.captured') return res.json({ success: true, ignored: event.event || null });

  const payment = event.payload?.payment?.entity || {};
  const paymentId = String(payment.id || '');
  const amount = toRupees(payment.amount);
  // createOrder() puts these in `notes` when the top-up is started.
  const customerId = String(payment.notes?.customerId || '');
  const ledgerEntryId = String(payment.notes?.ledgerEntryId || '');

  if (!paymentId || !customerId || !ledgerEntryId || !(amount > 0)) {
    // 200, not 4xx: the signature was genuine, so this is a Razorpay event we
    // cannot act on rather than an attack. A non-2xx would make Razorpay retry
    // it forever.
    console.warn('razorpay webhook: captured payment missing routing notes', paymentId);
    return res.json({ success: true, ignored: 'missing notes' });
  }

  const custRef = col.customers().doc(customerId);
  const entryRef = col.walletLedger(customerId).doc(ledgerEntryId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const [custSnap, entrySnap] = await Promise.all([tx.get(custRef), tx.get(entryRef)]);
      if (!custSnap.exists) throw new Error('Customer not found');
      if (!entrySnap.exists) throw new Error('Ledger entry not found');
      const entry = entrySnap.data();

      // Idempotency: a retry of the SAME payment is a no-op, not a second
      // credit. Checking the stored payment id rather than just the settled
      // flag also means a different payment cannot settle an entry that some
      // other payment already closed.
      if (entry.status === 'settled') {
        return { newBalance: Number(custSnap.data().balance || 0), duplicate: entry.paymentId === paymentId };
      }

      const newBalance = Number(custSnap.data().balance || 0) + amount;
      tx.update(custRef, { balance: newBalance });
      tx.update(entryRef, {
        status: 'settled',
        amount,                       // what Razorpay captured, not what the client asked for
        paymentId,
        settledAt: FieldValue.serverTimestamp(),
        settledBy: 'razorpay-webhook',
        newBalance,
      });
      return { newBalance, duplicate: false };
    });
    if (!result.duplicate) {
      await col.auditLog().add({
        adminId: 'razorpay-webhook', action: 'wallet_topup_settled',
        target: `${customerId}/${ledgerEntryId}`,
        before: null, after: { paymentId, amount, newBalance: result.newBalance },
        at: FieldValue.serverTimestamp(),
      });
    }
    res.json({ success: true });
  } catch (e) {
    // 500 so Razorpay retries — a transient Firestore failure must not lose a
    // real payment.
    console.error('razorpay webhook: settlement failed', paymentId, e.message);
    res.status(500).json({ success: false, message: 'Could not settle this payment' });
  }
});

module.exports = router;
