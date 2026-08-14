const router = require('express').Router();
const { col, db, FieldValue } = require('../services/firestore');
const { requireAuth } = require('../middleware/auth');

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
      txns: ledgerSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    },
  });
});

// POST /wallet/topup { amount, note } — this only RECORDS a deposit request.
// It does not move real money and does not credit the balance itself — an admin
// must confirm the transfer was actually received (see routes/admin.js) before
// the ledger entry is marked settled and the balance updated. Never trust a
// client-submitted top-up as proof of payment.
router.post('/topup', async (req, res) => {
  const amount = Number(req.body?.amount) || 0;
  if (amount < 1000) return res.status(400).json({ success: false, message: 'Minimum deposit is ₹1,000' });

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
