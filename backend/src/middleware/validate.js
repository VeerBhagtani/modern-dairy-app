// Small, dependency-free validators for server-side input checking. Frontend
// validation (www/index.html) exists too, but it's advisory only — every one
// of these must be re-checked here since the client can never be trusted.

const PHONE_RE = /^[6-9]\d{9}$/;
// 4-8 digits: the live provider (Message Central) issues 4-digit codes and
// Twilio Verify issues 6, so pinning this to exactly 6 would have rejected
// every real code the moment this backend went live. Still strictly numeric
// and strictly bounded - nothing else is accepted.
const OTP_RE = /^\d{4,8}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // Firestore-doc-id-safe, bounded length

function isValidPhone(phone) {
  return typeof phone === 'string' && PHONE_RE.test(phone.replace(/\D/g, '').slice(-10));
}
function isValidOtp(otp) {
  return typeof otp === 'string' && OTP_RE.test(otp);
}
function isValidGstin(gstin) {
  return typeof gstin === 'string' && GSTIN_RE.test(gstin.toUpperCase());
}
function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}
function isBoundedString(v, { min = 0, max = 200 } = {}) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}
function isOptionalBoundedString(v, opts) {
  return v === undefined || v === null || isBoundedString(v, opts);
}
function isPositiveInt(v, { max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isInteger(v) && v > 0 && v <= max;
}

// Mass-assignment guard. Returns a NEW object containing only the allowed
// keys, so a request body can never introduce a field the caller was not
// meant to set (role, ownership, verification/payment status, priceVerified,
// ...). Always build the document from the return value of this - never from
// req.body directly.
function pickAllowed(body, allowedKeys) {
  const out = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
  for (const k of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}
// Firestore rejects field names wrapped in double underscores, but reject
// prototype-polluting keys here too so they never reach any other sink.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function hasForbiddenKeys(body) {
  return !!body && typeof body === 'object'
    && Object.keys(body).some((k) => FORBIDDEN_KEYS.has(k));
}

// Admin recovery numbers arrive as one comma-separated Secret Manager value.
// Anything that isn't a valid Indian mobile is dropped rather than texted.
function parseRecoveryPhones(raw) {
  return String(raw || '').split(',')
    .map((s) => s.replace(/\D/g, '').slice(-10))
    .filter((p) => PHONE_RE.test(p));
}
// The only form of a recovery number that ever leaves the server.
function maskPhone(phone) {
  return '••••••' + String(phone).slice(-4);
}
// Why a new admin password is unacceptable, or null if it is fine.
function adminPasswordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use at least one letter and one number.';
  return null;
}

module.exports = {
  isValidPhone, isValidOtp, isValidGstin, isValidId,
  isBoundedString, isOptionalBoundedString, isPositiveInt,
  pickAllowed, hasForbiddenKeys,
  parseRecoveryPhones, maskPhone, adminPasswordProblem,
};
