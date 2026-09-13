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
  const razorpayOrderId = String(payment.order_id || '');

  /* Finding the ledger entry this payment belongs to.
   *
   * createOrder() puts customerId and ledgerEntryId in the ORDER's `notes`,
   * and for the standard checkout flow Razorpay copies those onto the payment
   * — so notes are the fast path. But that propagation is not something to
   * bet money on: if it ever does not happen, a captured payment would be
   * quietly dropped here and the customer would have paid for nothing.
   *
   * So `order_id` is the real key. It is always present on a payment made
   * against an order, and wallet.js stores it on the ledger entry. Notes are
   * used when present and then VERIFIED against it; when they are absent or
   * disagree, the entry is found by querying for the stored order id instead.
   */
  let customerId = String(payment.notes?.customerId || '');
  let ledgerEntryId = String(payment.notes?.ledgerEntryId || '');

  if (customerId && ledgerEntryId && razorpayOrderId) {
    const hinted = await col.walletLedger(customerId).doc(ledgerEntryId).get().catch(() => null);
    // Notes that point at an entry booked for a DIFFERENT Razorpay order are
    // not a routing hint, they are a mismatch — fall through to the lookup
    // rather than crediting whatever they point at.
    if (!hinted || !hinted.exists || String(hinted.data().razorpayOrderId || '') !== razorpayOrderId) {
      console.warn('razorpay webhook: notes did not match the payment order; falling back to order_id lookup', paymentId);
      customerId = ''; ledgerEntryId = '';
    }
  } else {
    customerId = ''; ledgerEntryId = '';
  }

  if (!customerId && razorpayOrderId) {
    const found = await col.walletLedgerGroup()
      .where('razorpayOrderId', '==', razorpayOrderId).limit(1).get().catch(() => null);
    if (found && !found.empty) {
      const d = found.docs[0];
      ledgerEntryId = d.id;
      customerId = d.ref.parent.parent.id;   // customers/{customerId}/wallet_ledger/{entry}
    }
  }

  if (!paymentId || !customerId || !ledgerEntryId || !(amount > 0)) {
    // 200, not 4xx: the signature was genuine, so this is a Razorpay event we
    // cannot act on rather than an attack, and a non-2xx would make Razorpay
    // retry it forever. Logged as an error, not a warning — a captured payment
    // nobody can route is money received against no deposit request.
    console.error('razorpay webhook: captured payment could not be matched to a deposit request',
      { paymentId, razorpayOrderId, amount });
    return res.json({ success: true, ignored: 'unroutable payment' });
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
      // credit. Razorpay retries webhooks, so this is the normal path, not an
      // edge case.
      //
      // A DIFFERENT payment arriving for an already-settled entry is not a
      // retry — it means two payments were captured against one deposit
      // request, so somebody has been charged for money the balance never
      // received. That must not be silently swallowed as a duplicate: it is
      // reported separately below so it lands in the audit log as an anomaly
      // for a human, and it is still not double-credited here.
      if (entry.status === 'settled') {
        return {
          newBalance: Number(custSnap.data().balance || 0),
          duplicate: entry.paymentId === paymentId,
          conflictingPaymentId: entry.paymentId === paymentId ? null : (entry.paymentId || null),
        };
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
    if (result.conflictingPaymentId) {
      // Two captured payments, one deposit request. Nobody is double-credited,
      // but somebody may be owed a refund — so this is recorded loudly rather
      // than passed off as a duplicate webhook.
      console.error('razorpay webhook: SECOND payment for an already-settled entry',
        { ledgerEntryId, settledBy: result.conflictingPaymentId, rejected: paymentId, amount });
      await col.auditLog().add({
        adminId: 'razorpay-webhook', action: 'wallet_topup_double_payment',
        target: `${customerId}/${ledgerEntryId}`,
        before: { settledByPaymentId: result.conflictingPaymentId },
        after: { rejectedPaymentId: paymentId, amount, note: 'Captured payment NOT credited — entry was already settled by a different payment. Check whether a refund is owed.' },
        at: FieldValue.serverTimestamp(),
      });
    } else if (!result.duplicate) {
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
