const router = require('express').Router();
const { col, db, FieldValue } = require('../services/firestore');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isOptionalBoundedString } = require('../middleware/validate');
const razorpay = require('../services/razorpayClient');

router.use(requireAuth());

// GET /wallet — current balance + recent ledger entries.
router.get('/', async (req, res) => {
  const custDoc = await col.customers().doc(req.userId).get();
  if (!custDoc.exists) return res.status(404).json({ success: false, message: 'Account not found' });
  const ledgerSnap = await col.walletLedger(req.userId).orderBy('at', 'desc').limit(50).get();
  res.json({
    success: true,
    data: {
      balance: Number(custDoc.data().balance || 0),
      // Projected, not spread: ledger documents also carry settledBy (the
      // internal admin id that approved a deposit), which is operational
      // detail the customer has no reason to receive.
      txns: ledgerSnap.docs.map(d => {
        const t = d.data();
        return { id: d.id, type: t.type, amount: t.amount, note: t.note || '', status: t.status, at: t.at || null };
      }),
    },
  });
});

// POST /wallet/topup { amount, note } — this only RECORDS a deposit request.
// It does not move real money and does not credit the balance itself. Exactly
// two things can settle it:
//   · the Razorpay webhook, after verifying Razorpay's signature
//     (routes/payments.js), for an online payment; or
//   · an admin confirming a bank transfer actually arrived (routes/admin.js).
// A client saying "I paid" is never one of them.
//
// When Razorpay is configured this also opens a real Razorpay order and returns
// its id, so the checkout the customer sees is tied to a server-created order
// for a server-decided amount. The `notes` are what let the webhook find this
// ledger entry again — without them a captured payment cannot be routed.
router.post('/topup', writeLimiter, async (req, res) => {
  const amount = Number(req.body?.amount) || 0;
  if (!Number.isFinite(amount) || amount < 1000 || amount > 1000000) {
    return res.status(400).json({ success: false, message: 'Deposit amount must be between ₹1,000 and ₹10,00,000' });
  }
  if (!isOptionalBoundedString(req.body?.note, { max: 300 })) {
    return res.status(400).json({ success: false, message: 'note is too long' });
  }

  const entry = await col.walletLedger(req.userId).add({
    type: 'topup_requested',
    amount,
    note: req.body?.note || '',
    status: 'pending_confirmation',
    at: FieldValue.serverTimestamp(),
  });

  let razorpayOrder = null;
  try {
    const order = await razorpay.createOrder({
      amountInRupees: amount,
      receipt: entry.id,
      notes: { customerId: req.userId, ledgerEntryId: entry.id },
    });
    // keyId is the PUBLISHABLE Razorpay key — it is meant to be in the client,
    // unlike the key secret, which never leaves Secret Manager. Sending it here
    // means the app does not need its own copy of any Razorpay configuration.
    razorpayOrder = {
      id: order.id, amount: order.amount, currency: order.currency,
      keyId: await razorpay.publishableKeyId(),
    };
    await entry.update({ razorpayOrderId: order.id });
  } catch (e) {
    // Razorpay not configured, or its API is down. The deposit request still
    // stands and an admin can confirm a bank transfer against it — so this is
    // a degraded path, not a failure.
    if (e.code !== 'NOT_CONFIGURED') console.error('wallet topup: razorpay order failed', e.message);
  }

  res.json({
    success: true,
    data: { id: entry.id, status: 'pending_confirmation', amount, razorpayOrder },
  });
});

module.exports = router;
