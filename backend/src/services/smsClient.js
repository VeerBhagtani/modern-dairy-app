// Twilio Verify API v2 (https://www.twilio.com/docs/verify/api) — chosen as the
// SMS/OTP provider since none was specified. Swap this file if a different
// provider (MSG91, Gupshup, etc.) is preferred; the send/check contract below
// is what auth.js routes depend on, so keep sendOTP/checkOTP's signatures.
const { getSecret } = require('./secretManager');

const BASE_URL = 'https://verify.twilio.com/v2';

async function creds() {
  const accountSid = await getSecret('twilio_account_sid');
  const authToken = await getSecret('twilio_auth_token');
  const serviceSid = await getSecret('twilio_verify_service_sid');
  if (!accountSid || !authToken || !serviceSid) {
    const err = new Error('SMS/OTP provider is not configured yet. Add Twilio credentials in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return { accountSid, authToken, serviceSid };
}

function basicAuth(sid, token) {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
}

async function sendOTP(phoneE164) {
  const { accountSid, authToken, serviceSid } = await creds();
  const res = await fetch(`${BASE_URL}/Services/${serviceSid}/Verifications`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(accountSid, authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: phoneE164, Channel: 'sms' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`SMS send failed (${res.status}): ${body.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return res.json();
}

async function checkOTP(phoneE164, code) {
  const { accountSid, authToken, serviceSid } = await creds();
  const res = await fetch(`${BASE_URL}/Services/${serviceSid}/VerificationCheck`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(accountSid, authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: phoneE164, Code: code }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.status === 'approved';
}

module.exports = { sendOTP, checkOTP };
