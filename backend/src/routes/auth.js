const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { col, db, FieldValue } = require('../services/firestore');
const { issueTokens, verifyToken, revokeRefreshToken } = require('../middleware/auth');
const { authLimiter, otpPhoneLimiter } = require('../middleware/rateLimit');
const { isValidPhone, isValidOtp, isValidGstin, isBoundedString, isOptionalBoundedString } = require('../middleware/validate');
const gst = require('../services/gstClient');
// Message Central, NOT services/smsClient.js (Twilio). This route used to
// import the Twilio client while the customer app, the admin recovery flow and
// every configured secret were all Message Central — so the moment this
// backend went live, customer sign-in would have failed with NOT_CONFIGURED on
// every single request while admin recovery worked fine. Same provider
// everywhere now. smsClient.js is kept as a documented swap-in, not wired up.
const otp = require('../services/messageCentralClient');

function normalisePhone(phone) {
  return String(phone).replace(/\D/g, '').slice(-10);
}

// ── OTP challenge state ──────────────────────────────────────────────────
// Message Central is stateful in a way Twilio Verify is not: sendOtp returns a
// verificationId that validateOtp needs back. That id has to live somewhere,
// and "somewhere" is also the natural place to cap guesses — so this doubles as
// the server-side brute-force limit that the per-IP rate limiter cannot provide
// on its own (an attacker spreads across addresses; the attempt counter is per
// phone number and survives that). Same shape as the admin recovery challenge.
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const otpRef = (phone) => col.otpChallenges().doc(phone);

async function startChallenge(phone) {
  const verificationId = await otp.sendOtp(phone);
  await otpRef(phone).set({
    verificationId,
    attempts: 0,
    expiresAt: Date.now() + OTP_TTL_MS,
    createdAt: FieldValue.serverTimestamp(),
  });
}

// Spends one attempt inside a transaction BEFORE asking the provider, so
// parallel guesses cannot all slip in under the cap. Returns the challenge, or
// null when there is nothing valid left to check against.
async function spendAttempt(phone) {
  return db.runTransaction(async (t) => {
    const snap = await t.get(otpRef(phone));
    const c = snap.exists ? snap.data() : null;
    if (!c || !(Date.now() < c.expiresAt) || c.attempts >= OTP_MAX_ATTEMPTS) return null;
    t.update(otpRef(phone), { attempts: c.attempts + 1 });
    return c;
  });
}

// Every auth-sensitive route gets both limiters: 5/15min per IP, and (where
// the body carries a phone number) an additional 5/15min per phone number so
// an attacker can't spread an SMS-bombing attack against one victim across
// many source IPs.
router.use(authLimiter, otpPhoneLimiter);

// POST /auth/b2b/verify-gstin { gstin, companyName }
// Advisory only — it powers the inline check in the signup form. It is NOT
// what grants a b2b account; see /b2b/register below, which re-verifies
// server-side and records the result against the phone number.
router.post('/b2b/verify-gstin', async (req, res) => {
  const { gstin, companyName } = req.body || {};
  if (!isValidGstin(gstin)) return res.status(400).json({ success: false, message: 'A valid GSTIN is required' });
  if (!isOptionalBoundedString(companyName, { max: 200 })) return res.status(400).json({ success: false, message: 'companyName is too long' });
  try {
    const data = await gst.verifyGSTIN(gstin.toUpperCase());
    res.json({ success: true, data });
  } catch (e) {
    const status = e.code === 'NOT_CONFIGURED' ? 503 : 400;
    res.status(status).json({ success: false, message: e.message });
  }
});

// POST /auth/b2b/register { gstin, companyName, name, phone }
//
// This is the ONLY route that can make a b2b account possible. It verifies the
// GSTIN against the provider itself and records that verification against this
// phone number; verify-otp then refuses to issue a b2b account without that
// record. Previously the tier came from the URL and the GSTIN came from the
// request body with nothing tying either to a real check, so anyone could self
// -grant wholesale pricing and credit terms using any structurally valid GSTIN
// — and GSTINs are public, they are printed on invoices.
router.post('/b2b/register', async (req, res) => {
  const { gstin, companyName, name } = req.body || {};
  const phone = normalisePhone(req.body?.phone);
  if (!isValidGstin(gstin)) return res.status(400).json({ success: false, message: 'A valid GSTIN is required' });
  if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'A valid 10-digit mobile number is required' });
  if (!isBoundedString(name, { min: 1, max: 100 })) return res.status(400).json({ success: false, message: 'A valid name is required' });
  if (!isOptionalBoundedString(companyName, { max: 200 })) return res.status(400).json({ success: false, message: 'companyName is too long' });

  let gstData;
  try {
    gstData = await gst.verifyGSTIN(gstin.toUpperCase());
  } catch (e) {
    const status = e.code === 'NOT_CONFIGURED' ? 503 : 400;
    return res.status(status).json({ success: false, message: e.message });
  }

  try {
    await startChallenge(phone);
  } catch (e) {
    const status = e.code === 'NOT_CONFIGURED' ? 503 : 502;
    return res.status(status).json({ success: false, message: e.message });
  }

  // Recorded only after the code is actually on its way, and short-lived: this
  // is proof for THIS signup, not a standing entitlement.
  await col.gstVerifications().doc(phone).set({
    gstin: gstin.toUpperCase(),
    legalName: gstData?.legalName || companyName || null,
    verifiedAt: FieldValue.serverTimestamp(),
    expiresAt: Date.now() + OTP_TTL_MS,
  });

  res.json({ success: true });
});

// POST /auth/b2b/send-otp { phone }  and  POST /auth/b2c/send-otp { phone, name }
router.post('/:mode(b2b|b2c)/send-otp', async (req, res) => {
  const { name } = req.body || {};
  const phone = normalisePhone(req.body?.phone);
  if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'A valid 10-digit mobile number is required' });
  if (!isOptionalBoundedString(name, { max: 100 })) return res.status(400).json({ success: false, message: 'name is too long' });
  try {
    await startChallenge(phone);
    res.json({ success: true });
  } catch (e) {
    const status = e.code === 'NOT_CONFIGURED' ? 503 : 502;
    res.status(status).json({ success: false, message: e.message });
  }
});

// POST /auth/:mode/verify-otp { phone, otp, name, company, gstin }
router.post('/:mode(b2b|b2c)/verify-otp', async (req, res) => {
  const { mode } = req.params;
  const { otp: code, name, company, gstin } = req.body || {};
  const phone = normalisePhone(req.body?.phone);
  if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'A valid 10-digit mobile number is required' });
  if (!isValidOtp(code)) return res.status(400).json({ success: false, message: 'Incorrect or expired code.' }); // same message as a wrong code — no format oracle
  if (!isOptionalBoundedString(name, { max: 100 })) return res.status(400).json({ success: false, message: 'name is too long' });
  if (mode === 'b2b') {
    if (company !== undefined && !isBoundedString(company, { max: 200 })) return res.status(400).json({ success: false, message: 'company is too long' });
    if (gstin !== undefined && gstin !== null && !isValidGstin(gstin)) return res.status(400).json({ success: false, message: 'gstin is not valid' });
  }

  const challenge = await spendAttempt(phone);
  if (!challenge) {
    return res.status(400).json({ success: false, message: 'That code has expired or been used up. Request a new one.' });
  }
  let ok;
  try {
    ok = await otp.validateOtp(challenge.verificationId, code);
  } catch (e) {
    return res.status(503).json({ success: false, message: 'Could not check the code right now. Please try again.' });
  }
  if (!ok) return res.status(400).json({ success: false, message: 'Incorrect or expired code.' });
  await otpRef(phone).delete().catch(() => {});

  // ── Tier is decided here, from server-held facts only ──────────────────
  // Never from the URL and never from the request body. A caller asking for
  // b2b without a live verification record gets a b2c account: the failure
  // direction is always toward LESS entitlement.
  let verifiedGst = null;
  if (mode === 'b2b') {
    const snap = await col.gstVerifications().doc(phone).get();
    const v = snap.exists ? snap.data() : null;
    if (v && Date.now() < Number(v.expiresAt || 0)) verifiedGst = v;
  }
  const tier = verifiedGst ? 'b2b' : 'b2c';

  // Find existing customer by phone, else create.
  const existingSnap = await col.customers().where('phone', '==', phone).limit(1).get();
  let userDoc, userData;
  if (!existingSnap.empty) {
    userDoc = existingSnap.docs[0];
    userData = userDoc.data();
    // An existing account keeps its tier. Upgrades are a deliberate, audited
    // admin action (POST /admin/customers/:id/tier), never a side effect of
    // signing in again with a b2b URL.
  } else {
    const id = uuid();
    userData = {
      name: name || 'Customer',
      phone,
      customerType: tier,
      company: tier === 'b2b' ? (verifiedGst.legalName || company || null) : null,
      gstin: tier === 'b2b' ? verifiedGst.gstin : null,
      balance: 0,
      createdAt: FieldValue.serverTimestamp(),
    };
    await col.customers().doc(id).set(userData);
    userDoc = { id };
  }
  if (verifiedGst) await col.gstVerifications().doc(phone).delete().catch(() => {});

  const user = {
    id: userDoc.id,
    name: userData.name,
    phone: userData.phone,
    customerType: userData.customerType,
    company: userData.company || null,
    gstin: userData.gstin || null,
  };
  const tokens = await issueTokens(user);
  const body = { success: true, data: { user, ...tokens } };
  // Tell the caller plainly when they asked for b2b and did not get it, rather
  // than letting the app discover it later via unexpected retail pricing.
  if (mode === 'b2b' && user.customerType !== 'b2b') {
    body.notice = 'This account is a personal account. Business pricing needs a verified GSTIN — please complete business registration.';
  }
  res.json(body);
});

// POST /auth/refresh { refreshToken }
// Rotating: the presented token is consumed and a NEW refresh token is issued.
// Re-presenting a consumed token is treated as theft and kills the whole family
// (see revokeRefreshToken / middleware/auth.js).
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!isBoundedString(refreshToken, { min: 1, max: 2000 })) return res.status(400).json({ success: false, message: 'refreshToken is required' });
  try {
    const payload = await verifyToken(refreshToken, 'refresh');
    const doc = await col.customers().doc(payload.sub).get();
    if (!doc.exists) return res.status(401).json({ success: false, message: 'Account no longer exists' });
    const tokens = await issueTokens({ id: doc.id }, { rotatedFrom: payload });
    res.json({ success: true, data: tokens });
  } catch (e) {
    res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
});

// POST /auth/logout { refreshToken } — actually revokes it server-side.
// Without this, "sign out" only cleared the token from the device while it
// stayed valid for its full 30 days to anyone who had captured it.
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (isBoundedString(refreshToken, { min: 1, max: 2000 })) {
    try {
      const payload = await verifyToken(refreshToken, 'refresh');
      await revokeRefreshToken(payload);
    } catch (e) { /* already invalid — nothing to revoke */ }
  }
  res.json({ success: true });
});

module.exports = router;
