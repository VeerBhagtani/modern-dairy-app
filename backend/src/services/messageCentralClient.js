// Message Central VerifyNow — the OTP provider the customer app already uses
// (see otpApi in www/index.html). Called from the server here so its auth
// token lives in Secret Manager instead of in a page anyone can read.
//
// The credentials are read by raw secret id, NOT through KNOWN_SECRETS, so
// POST /admin/secrets cannot replace them: whoever controls the OTP account
// can read the codes it sends, and a stolen admin session must not be able to
// swap in an account of its own.
const { getSecret } = require('./secretManager');

const BASE_URL = 'https://cpaas.messagecentral.com';
const TIMEOUT_MS = 20000;

async function creds() {
  const customerId = await getSecret('otp-customer-id');
  const authToken = await getSecret('otp-auth-token');
  if (!customerId || !authToken) {
    const err = new Error('The OTP provider is not set up on the server yet.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return { customerId, authToken };
}

async function call(path, params, method, authToken) {
  const res = await fetch(`${BASE_URL}${path}?${new URLSearchParams(params)}`, {
    method,
    headers: { authToken },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body — status alone decides */ }
  return { ok: res.ok && data.responseCode === 200, status: res.status, data };
}

// Texts a 4-digit code; returns the verificationId the code is checked against.
async function sendOtp(mobile10) {
  const { customerId, authToken } = await creds();
  const r = await call('/verification/v3/send',
    { countryCode: '91', customerId, flowType: 'SMS', otpLength: '4', mobileNumber: mobile10 }, 'POST', authToken);
  const verificationId = r.data?.data?.verificationId;
  if (!r.ok || !verificationId) {
    // Deliberately not echoing the provider's body: it can carry the number.
    const err = new Error(`OTP send failed (HTTP ${r.status})`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return String(verificationId);
}

async function validateOtp(verificationId, code) {
  const { authToken } = await creds();
  const r = await call('/verification/v3/validateOtp', { verificationId, code }, 'GET', authToken);
  if (!r.ok) return false;
  const status = r.data?.data?.verificationStatus;
  return status === undefined || status === 'VERIFICATION_COMPLETED';
}

module.exports = { sendOtp, validateOtp };
