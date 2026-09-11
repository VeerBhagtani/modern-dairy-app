// Admin password recovery. "Forgot password?" on the admin website's sign-in
// screen and "Change password" in its Settings tab both land here.
//
// The only proof accepted is an SMS code sent to one of the recovery numbers.
// Those numbers live in Secret Manager ('admin-recovery-phones', comma-
// separated) and nowhere else — not in this repo, not in the web page, which
// is only ever shown the last four digits. They are read by raw secret id and
// are deliberately NOT in KNOWN_SECRETS, so POST /admin/secrets cannot rewrite
// them: a stolen admin session must not be able to point recovery at the
// thief's own phone. Only the GCP project owner can change them.
//
// The new password goes straight to Firebase Auth, which keeps only a salted
// hash. It is never stored in Firestore, logged, or sent back.
const router = require('express').Router();
const { db, admin, writeAuditLog } = require('../services/firestore');
const { getSecret } = require('../services/secretManager');
const otp = require('../services/messageCentralClient');
const { ADMIN_FIREBASE_UID } = require('../middleware/adminAuth');
const { authLimiter, recoverySendLimiter } = require('../middleware/rateLimit');
const { isValidOtp, parseRecoveryPhones, maskPhone, adminPasswordProblem } = require('../middleware/validate');

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// One admin, so one outstanding challenge; sending a new code replaces it.
const challengeRef = () => db.collection('admin_recovery').doc('challenge');

async function recoveryPhones() {
  const phones = parseRecoveryPhones(await getSecret('admin-recovery-phones'));
  if (!phones.length) {
    const err = new Error('Password recovery is not set up on the server yet.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return phones;
}

function sendError(res, e, fallback) {
  if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ success: false, message: e.message });
  console.error('admin-recovery:', e.code || '', e.message);
  res.status(502).json({ success: false, message: fallback });
}

// GET /admin-recovery/options -> [{ id, label: '••••••0666' }]
router.get('/options', async (req, res) => {
  try {
    const phones = await recoveryPhones();
    res.json({ success: true, data: phones.map((p, id) => ({ id, label: maskPhone(p) })) });
  } catch (e) { sendError(res, e, 'Could not load the recovery numbers.'); }
});

// POST /admin-recovery/send-otp { which } — `which` is an index into the
// server's list, never a phone number, so a code can only reach those phones.
router.post('/send-otp', authLimiter, recoverySendLimiter, async (req, res) => {
  const which = req.body?.which;
  try {
    const phones = await recoveryPhones();
    if (!Number.isInteger(which) || which < 0 || which >= phones.length) {
      return res.status(400).json({ success: false, message: 'Pick one of the listed numbers.' });
    }
    const verificationId = await otp.sendOtp(phones[which]);
    await challengeRef().set({ which, verificationId, attempts: 0, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    await writeAuditLog({ adminId: 'recovery', action: 'admin_recovery_code_sent', target: maskPhone(phones[which]) });
    res.json({ success: true });
  } catch (e) { sendError(res, e, 'Could not send the code. Please try again.'); }
});

// POST /admin-recovery/reset { which, otp, newPassword }
router.post('/reset', authLimiter, async (req, res) => {
  const { which, otp: code, newPassword } = req.body || {};
  if (!isValidOtp(code)) return res.status(400).json({ success: false, message: 'Incorrect or expired code.' });
  const problem = adminPasswordProblem(newPassword);
  if (problem) return res.status(400).json({ success: false, message: problem });
  try {
    // Spend one attempt inside a transaction before asking the provider, so
    // parallel guesses cannot all slip in under the cap.
    const challenge = await db.runTransaction(async (t) => {
      const snap = await t.get(challengeRef());
      const c = snap.exists ? snap.data() : null;
      if (!c || c.which !== which || !(Date.now() < c.expiresAt) || c.attempts >= MAX_ATTEMPTS) return null;
      t.update(challengeRef(), { attempts: c.attempts + 1 });
      return c;
    });
    if (!challenge) {
      return res.status(400).json({ success: false, message: 'That code has expired or been used up. Send a new one.' });
    }
    if (!(await otp.validateOtp(challenge.verificationId, code))) {
      return res.status(400).json({ success: false, message: 'Incorrect or expired code.' });
    }
    await challengeRef().delete();
    await admin.auth().updateUser(ADMIN_FIREBASE_UID, { password: newPassword });
    // Ends every existing admin session, including one a thief may be holding.
    await admin.auth().revokeRefreshTokens(ADMIN_FIREBASE_UID);
    await writeAuditLog({ adminId: 'recovery', action: 'admin_password_reset', target: `recovery number ${which + 1}` });
    res.json({ success: true });
  } catch (e) { sendError(res, e, 'Could not change the password. Please try again.'); }
});

module.exports = router;
