// Small, dependency-free validators for server-side input checking. Frontend
// validation (www/index.html) exists too, but it's advisory only — every one
// of these must be re-checked here since the client can never be trusted.

const PHONE_RE = /^[6-9]\d{9}$/;
const OTP_RE = /^\d{6}$/;
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

module.exports = {
  isValidPhone, isValidOtp, isValidGstin, isValidId,
  isBoundedString, isOptionalBoundedString, isPositiveInt,
};
