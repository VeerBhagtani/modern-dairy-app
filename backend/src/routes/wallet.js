const router = require('express').Router();
const { col, db, FieldValue } = require('../services/firestore');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isOptionalBoundedString } = require('../middleware/validate');

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
// It does not move real money and does not credit the balance itself — an admin
// must confirm the transfer was actually received (see routes/admin.js) before
// the ledger entry is marked settled and the balance updated. Never trust a
// client-submitted top-up as proof of payment.
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
  res.json({ success: true, data: { id: entry.id, status: 'pending_confirmation' } });
});

module.exports = router;
