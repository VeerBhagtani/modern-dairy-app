const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { col, FieldValue } = require('../services/firestore');
const { issueTokens, verifyToken } = require('../middleware/auth');
const gst = require('../services/gstClient');
const sms = require('../services/smsClient');

function toE164(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.startsWith('91') ? `+${digits}` : `+91${digits}`;
}

// POST /auth/b2b/verify-gstin { gstin, companyName }
router.post('/b2b/verify-gstin', async (req, res) => {
  const { gstin } = req.body || {};
  if (!gstin) return res.status(400).json({ success: false, message: 'gstin is required' });
  try {
    const data = await gst.verifyGSTIN(gstin);
    res.json({ success: true, data });
  } catch (e) {
    const status = e.code === 'NOT_CONFIGURED' ? 503 : 400;
    res.status(status).json({ success: false, message: e.message });
  }
});

// POST /auth/b2b/register { gstin, companyName, name, phone, gstData }
// Registration only stages the profile; the account is created on OTP verify.
router.post('/b2b/register', async (req, res) => {
  const { gstin, companyName, name, phone, gstData } = req.body || {};
  if (!gstin || !phone) return res.status(400).json({ success: false, message: 'gstin and phone are required' });
  try {
    await sms.sendOTP(toE164(phone));
    res.json({ success: true });
  } catch (e) {
    const status = e.code === 'NOT_CONFIGURED' ? 503 : 502;
    res.status(status).json({ success: false, message: e.message });
  }
});

// POST /auth/b2b/send-otp { phone }  and  POST /auth/b2c/send-otp { phone, name }
router.post('/:mode(b2b|b2c)/send-otp', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ success: false, message: 'phone is required' });
  try {
    await sms.sendOTP(toE164(phone));
    res.json({ success: true });
  } catch (e) {
    const status = e.code === 'NOT_CONFIGURED' ? 503 : 502;
    res.status(status).json({ success: false, message: e.message });
  }
});

// POST /auth/:mode/verify-otp { phone, otp, name, company, gstin }
router.post('/:mode(b2b|b2c)/verify-otp', async (req, res) => {
  const { mode } = req.params;
  const { phone, otp, name, company, gstin } = req.body || {};
  if (!phone || !otp) return res.status(400).json({ success: false, message: 'phone and otp are required' });

  let ok;
  try {
    ok = await sms.checkOTP(toE164(phone), otp);
  } catch (e) {
    return res.status(503).json({ success: false, message: e.message });
  }
  if (!ok) return res.status(400).json({ success: false, message: 'Incorrect or expired code.' });

  // Find existing customer by phone, else create.
  const existingSnap = await col.customers().where('phone', '==', phone).limit(1).get();
  let userDoc, userData;
  if (!existingSnap.empty) {
    userDoc = existingSnap.docs[0];
    userData = userDoc.data();
  } else {
    const id = uuid();
    userData = {
      name: name || 'Customer',
      phone,
      customerType: mode,
      company: mode === 'b2b' ? (company || null) : null,
      gstin: mode === 'b2b' ? (gstin || null) : null,
      balance: 0,
      createdAt: FieldValue.serverTimestamp(),
    };
    await col.customers().doc(id).set(userData);
    userDoc = { id };
  }

  const user = {
    id: userDoc.id,
    name: userData.name,
    phone: userData.phone,
    customerType: userData.customerType,
    company: userData.company || null,
    gstin: userData.gstin || null,
  };
  const tokens = await issueTokens(user);
  res.json({ success: true, data: { user, ...tokens } });
});

// POST /auth/refresh { refreshToken }
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ success: false, message: 'refreshToken is required' });
  try {
    const payload = await verifyToken(refreshToken, 'refresh');
    const doc = await col.customers().doc(payload.sub).get();
    if (!doc.exists) return res.status(401).json({ success: false, message: 'Account no longer exists' });
    const user = { id: doc.id, ...doc.data() };
    const tokens = await issueTokens({ id: user.id });
    res.json({ success: true, data: { accessToken: tokens.accessToken } });
  } catch (e) {
    res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
});

module.exports = router;
