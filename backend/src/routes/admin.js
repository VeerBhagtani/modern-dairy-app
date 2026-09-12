const router = require('express').Router();
const { col, db, FieldValue } = require('../services/firestore');
const { writeAuditLog } = require('../services/firestore');
const { requireAdmin, verifyAdminLogin, issueAdminToken } = require('../middleware/adminAuth');
const { adminLoginLimiter, writeLimiter, generalLimiter } = require('../middleware/rateLimit');
const { isBoundedString, isValidId, isValidGstin, pickAllowed, hasForbiddenKeys } = require('../middleware/validate');
const secretManager = require('../services/secretManager');
const goFrugalClient = require('../services/goFrugalClient');

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

/* POST /admin/customers/:id/tier { customerType, gstin?, company? }
 *
 * The only way a customer's tier ever changes after their account exists.
 *
 * This endpoint exists because verify-otp deliberately refuses to change the
 * tier of an existing account: taking it from the request (which is what it
 * used to do) meant anyone could self-grant wholesale pricing and credit terms
 * by choosing a URL. But refusing there without providing a path here would
 * have meant a customer who first signed up personally could NEVER become a
 * business account — a real dead end for a genuine customer whose GSTIN
 * arrived later.
 *
 * So the upgrade is what the comment in auth.js says it is: deliberate,
 * performed by the office, and written to the audit log with who did it.
 */
router.post('/customers/:id/tier', writeLimiter, async (req, res) => {
  const { id } = req.params;
  const { customerType, gstin, company } = req.body || {};
  if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid customer id' });
  if (customerType !== 'b2b' && customerType !== 'b2c') {
    return res.status(400).json({ success: false, message: "customerType must be 'b2b' or 'b2c'" });
  }
  if (customerType === 'b2b' && !isValidGstin(gstin)) {
    // A business account without a GSTIN is the thing this whole path exists to
    // prevent, so it is refused here too — not only at signup.
    return res.status(400).json({ success: false, message: 'A valid GSTIN is required to make an account a business account' });
  }
  if (company !== undefined && company !== null && !isBoundedString(company, { max: 200 })) {
    return res.status(400).json({ success: false, message: 'company is too long' });
  }

  const ref = col.customers().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, message: 'Customer not found' });
  const before = { customerType: snap.data().customerType, gstin: snap.data().gstin || null, company: snap.data().company || null };

  const after = customerType === 'b2b'
    ? { customerType: 'b2b', gstin: String(gstin).toUpperCase(), company: company || snap.data().company || null }
    : { customerType: 'b2c', gstin: null, company: null };

  await ref.set(after, { merge: true });
  await writeAuditLog({ adminId: req.adminId, action: 'customer_tier_changed', target: id, before, after });
  res.json({ success: true, data: after });
});

// GET /admin/audit-log
router.get('/audit-log', async (req, res) => {
  const snap = await col.auditLog().orderBy('at', 'desc').limit(200).get();
  res.json({ success: true, data: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

// POST /admin/orders/:id/bill — raise this order's bill in GoFrugal.
//
// This is what the Bills tab's Print button calls before it prints. GoFrugal
// is the billing system of record: it allots the legal invoice number and,
// where applicable, registers the e-invoice. We store what it returns and
// print that.
//
// IDEMPOTENT BY DESIGN. "Print all 40 bills" pressed twice must not raise 80
// bills, and a reprint must never raise a second one. An order that already
// carries gofrugal.billNo is returned as-is with created:false — the caller
// can then print immediately. The claim is staked inside a transaction before
// the network call, so two admins pressing Print at the same moment cannot
// both get through.
router.post('/orders/:id/bill', writeLimiter, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid order id' });

  const ref = col.orders().doc(id);
  let order;
  try {
    order = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) { const e = new Error('Order not found'); e.status = 404; throw e; }
      const data = { id: snap.id, ...snap.data() };

      if (data.gofrugal?.billNo) return { already: data.gofrugal, data };

      // A bill in progress from another click/tab. Two minutes is far longer
      // than the 20s client timeout, so a genuinely stuck claim clears itself
      // rather than locking the order out for good.
      const claimedAt = data.gofrugal?.claimedAt?.toMillis?.();
      if (claimedAt && Date.now() - claimedAt < 120000) {
        const e = new Error('A bill is already being raised for this order. Try again in a moment.');
        e.status = 409;
        throw e;
      }
      tx.set(ref, { gofrugal: { claimedAt: FieldValue.serverTimestamp(), claimedBy: req.adminId } }, { merge: true });
      return { already: null, data };
    });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }

  if (order.already) {
    return res.json({ success: true, data: { created: false, gofrugal: order.already } });
  }

  let result;
  try {
    result = await goFrugalClient.raiseBill(order.data);
  } catch (e) {
    // Release the claim so a retry is possible — except on a timeout, where
    // the bill may in fact exist in GoFrugal. Leaving that claim in place for
    // its two minutes is the safer failure: better a delayed retry than a
    // duplicate bill in the books.
    if (e.code !== 'PROVIDER_TIMEOUT') {
      await ref.set({ gofrugal: { claimedAt: null, claimedBy: null } }, { merge: true }).catch(() => {});
    }
    await writeAuditLog({ adminId: req.adminId, action: 'gofrugal_bill_failed', target: id, after: { code: e.code || null, message: e.message } });
    const status = e.code === 'NOT_CONFIGURED' ? 400 : 502;
    return res.status(status).json({ success: false, code: e.code || 'PROVIDER_ERROR', message: e.message });
  }

  // GoFrugal recomputes tax from its own masters. If its total disagrees with
  // what the customer was charged, that is a catalogue/tax-master mismatch and
  // an operator has to look at it — so it is recorded and surfaced, never
  // silently printed over.
  const mismatch = result.total !== null && Math.abs(result.total - (Number(order.data.total) || 0)) > 1;

  const gofrugal = {
    billNo: result.billNo,
    billDate: result.billDate || null,
    irn: result.irn || null,
    ackNo: result.ackNo || null,
    ackDate: result.ackDate || null,
    signedQr: result.signedQr || null,
    total: result.total,
    totalMismatch: mismatch,
    raisedAt: FieldValue.serverTimestamp(),
    raisedBy: req.adminId,
    claimedAt: null,
    claimedBy: null,
  };
  await ref.set({ gofrugal }, { merge: true });
  await writeAuditLog({
    adminId: req.adminId, action: 'gofrugal_bill_raised', target: id,
    after: { billNo: result.billNo, irn: result.irn || null, totalMismatch: mismatch },
  });

  res.json({ success: true, data: { created: true, gofrugal, totalMismatch: mismatch } });
});

module.exports = router;
