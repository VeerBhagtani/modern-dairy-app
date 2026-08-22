const router = require('express').Router();
const { col, db, FieldValue } = require('../services/firestore');
const { writeAuditLog } = require('../services/firestore');
const { requireAdmin, verifyAdminLogin, issueAdminToken } = require('../middleware/adminAuth');
const { adminLoginLimiter, writeLimiter, generalLimiter } = require('../middleware/rateLimit');
const { isBoundedString, isValidId, pickAllowed, hasForbiddenKeys } = require('../middleware/validate');
const secretManager = require('../services/secretManager');

// POST /admin/login { username, password } — no auth required (this IS the login).
// 5 attempts / 15 min, keyed by IP + attempted username (see rateLimit.js).
router.post('/login', adminLoginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!isBoundedString(username, { min: 1, max: 100 }) || !isBoundedString(password, { min: 1, max: 200 })) {
    return res.status(400).json({ success: false, message: 'Incorrect username or password' }); // same message as a real mismatch — no format oracle
  }
  const admin = await verifyAdminLogin(username, password);
  if (!admin) return res.status(401).json({ success: false, message: 'Incorrect username or password' });
  const token = await issueAdminToken(admin.id);
  res.json({ success: true, data: { token } });
});

router.use(requireAdmin());
router.use(generalLimiter);

// GET /admin/secrets/status — {alias: 'configured'|'missing'} for every known integration.
router.get('/secrets/status', async (req, res) => {
  const status = await secretManager.secretStatus();
  res.json({ success: true, data: status });
});

// POST /admin/secrets { key, value } — stores in Secret Manager, never echoes the value back.
router.post('/secrets', writeLimiter, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || typeof value !== 'string') return res.status(400).json({ success: false, message: 'key and value are required' });
  if (!secretManager.KNOWN_SECRETS[key]) return res.status(400).json({ success: false, message: `Unknown secret key: ${key}` });
  if (value.length === 0 || value.length > 4096) return res.status(400).json({ success: false, message: 'value must be between 1 and 4096 characters' });
  await secretManager.setSecret(key, value);
  await writeAuditLog({ adminId: req.adminId, action: 'secret_updated', target: key });
  res.json({ success: true });
});

// GET /admin/config
router.get('/config', async (req, res) => {
  const doc = await col.appConfig().get();
  res.json({ success: true, data: doc.exists ? doc.data() : {} });
});

// Fields the public app_config document is actually allowed to carry — keeps
// this endpoint from becoming a way to write arbitrary, unbounded data that
// every customer's app then fetches on every boot.
const CONFIG_FIELDS = new Set([
  'businessName', 'logo', 'supportPhone', 'whatsapp', 'email', 'instagram', 'linkedin',
  'address', 'minOrderValue', 'freeDeliveryAbove', 'deliveryFee', 'platformFee', 'gstRate', 'orderCutoff',
  'businessHours', 'announcement', 'walletEnabled',
]);

// PUT /admin/config — partial update of the public app_config document.
router.put('/config', writeLimiter, async (req, res) => {
  const patch = req.body || {};
  const keys = Object.keys(patch);
  if (keys.length === 0) return res.status(400).json({ success: false, message: 'Request body is empty' });
  const unknown = keys.filter(k => !CONFIG_FIELDS.has(k));
  if (unknown.length) return res.status(400).json({ success: false, message: `Unknown config field(s): ${unknown.join(', ')}` });
  // The key allowlist alone didn't bound the VALUES. app_config is public and
  // every customer app merges it into its own runtime config on boot, so an
  // unbounded string here is pushed to every device.
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'string' && v.length > 2000) return res.status(400).json({ success: false, message: `${k} is too long (max 2000 characters)` });
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0 || v > 10000000)) return res.status(400).json({ success: false, message: `${k} is out of range` });
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) return res.status(400).json({ success: false, message: `${k} must be a string, number or boolean` });
  }

  const before = (await col.appConfig().get()).data() || {};
  await col.appConfig().set(patch, { merge: true });
  await writeAuditLog({ adminId: req.adminId, action: 'config_updated', target: 'app_config', before, after: patch });
  res.json({ success: true });
});

// GET /admin/products
router.get('/products', async (req, res) => {
  const snap = await col.products().get();
  res.json({ success: true, data: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

// Fields a product document may carry. Same reasoning as CONFIG_FIELDS
// above: this endpoint used to `set(req.body, {merge:true})` verbatim, so any
// key in the body became a field on a PUBLICLY READABLE document — unbounded
// junk, or an unexpected field that client code then trusts. Everything is
// allowlisted and type-checked before it is written.
const PRODUCT_FIELDS = ['name', 'cat', 'img', 'unit', 'desc', 'storage', 'freshness', 'variants', 'active'];
const VARIANT_FIELDS = ['id', 'label', 'mrp', 'b2b', 'moq', 'case', 'stock', 'lowStock'];
const MAX_FIELD_LEN = 2000;

function cleanProductPatch(body) {
  const patch = pickAllowed(body, PRODUCT_FIELDS);
  for (const k of ['name', 'cat', 'img', 'unit', 'desc', 'storage', 'freshness']) {
    if (k in patch) {
      if (typeof patch[k] !== 'string' || patch[k].length > MAX_FIELD_LEN) return { error: `${k} must be a string of at most ${MAX_FIELD_LEN} characters` };
    }
  }
  if ('active' in patch && typeof patch.active !== 'boolean') return { error: 'active must be a boolean' };
  if ('variants' in patch) {
    if (!Array.isArray(patch.variants) || patch.variants.length > 50) return { error: 'variants must be an array of at most 50 entries' };
    const cleaned = [];
    for (const v of patch.variants) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'each variant must be an object' };
      const cv = pickAllowed(v, VARIANT_FIELDS);
      if (!isValidId(cv.id)) return { error: 'each variant needs a valid id' };
      if (typeof cv.label !== 'string' || cv.label.length > 120) return { error: 'each variant needs a label of at most 120 characters' };
      for (const n of ['mrp', 'b2b', 'moq', 'case', 'lowStock']) {
        if (n in cv) {
          const num = Number(cv[n]);
          if (!Number.isFinite(num) || num < 0 || num > 1000000) return { error: `variant ${n} must be a number between 0 and 1000000` };
          cv[n] = num;
        }
      }
      if ('stock' in cv && !(['in', 'low', 'out'].includes(cv.stock) || (Number.isFinite(Number(cv.stock)) && Number(cv.stock) >= 0))) {
        return { error: "variant stock must be 'in' | 'low' | 'out' or a non-negative number" };
      }
      cleaned.push(cv);
    }
    patch.variants = cleaned;
  }
  return { patch };
}

// PUT /admin/products/:id — partial product document update (allowlisted).
router.put('/products/:id', writeLimiter, async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid product id' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ success: false, message: 'Request body must be an object' });
  }
  if (hasForbiddenKeys(req.body)) return res.status(400).json({ success: false, message: 'Request body contains a disallowed field name' });
  const { patch, error } = cleanProductPatch(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  if (!Object.keys(patch).length) return res.status(400).json({ success: false, message: 'No updatable product fields in request body' });

  const ref = col.products().doc(req.params.id);
  const before = (await ref.get()).data() || null;
  await ref.set(patch, { merge: true });
  await writeAuditLog({ adminId: req.adminId, action: 'product_updated', target: req.params.id, before, after: patch });
  res.json({ success: true });
});

// GET /admin/orders — all customers' orders, newest first (this is the real
// cross-device order view the local-only admin panel couldn't provide).
router.get('/orders', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const snap = await col.orders().orderBy('placedAt', 'desc').limit(limit).get();
  res.json({ success: true, data: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

// POST /admin/wallet/:customerId/confirm-topup { ledgerEntryId }
// Marks a pending deposit as settled and credits the balance atomically.
router.post('/wallet/:customerId/confirm-topup', writeLimiter, async (req, res) => {
  const { customerId } = req.params;
  const { ledgerEntryId } = req.body || {};
  if (!isValidId(customerId)) return res.status(400).json({ success: false, message: 'Invalid customerId' });
  if (!isValidId(ledgerEntryId)) return res.status(400).json({ success: false, message: 'ledgerEntryId is required' });

  const custRef = col.customers().doc(customerId);
  const entryRef = col.walletLedger(customerId).doc(ledgerEntryId);

  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const [custSnap, entrySnap] = await Promise.all([tx.get(custRef), tx.get(entryRef)]);
      if (!custSnap.exists) throw new Error('Customer not found');
      if (!entrySnap.exists) throw new Error('Ledger entry not found');
      const entry = entrySnap.data();
      if (entry.status === 'settled') throw new Error('Already settled');

      const newBalance = Number(custSnap.data().balance || 0) + Number(entry.amount);
      tx.update(custRef, { balance: newBalance });
      tx.update(entryRef, { status: 'settled', settledAt: FieldValue.serverTimestamp(), settledBy: req.adminId, newBalance });
      return newBalance;
    });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }

  await writeAuditLog({ adminId: req.adminId, action: 'wallet_topup_confirmed', target: `${customerId}/${ledgerEntryId}`, after: { newBalance: result } });
  res.json({ success: true, data: { newBalance: result } });
});

// GET /admin/audit-log
router.get('/audit-log', async (req, res) => {
  const snap = await col.auditLog().orderBy('at', 'desc').limit(200).get();
  res.json({ success: true, data: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

module.exports = router;
