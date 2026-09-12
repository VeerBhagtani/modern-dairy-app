// Razorpay Orders API v1 (https://razorpay.com/docs/api/orders/).
const { getSecret } = require('./secretManager');

const BASE_URL = 'https://api.razorpay.com/v1';

async function authHeader() {
  const keyId = await getSecret('razorpay_key_id');
  const keySecret = await getSecret('razorpay');
  if (!keyId || !keySecret) {
    const err = new Error('Razorpay is not configured yet. Add both the Key ID and Key Secret in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
}

// amountInRupees is converted to paise per Razorpay's requirement.
async function createOrder({ amountInRupees, receipt, notes }) {
  const auth = await authHeader();
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(amountInRupees * 100),
      currency: 'INR',
      receipt,
      notes: notes || {},
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Razorpay order creation failed (${res.status}): ${body.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return res.json();
}

async function verifyWebhookSignature(rawBody, signature) {
  const crypto = require('crypto');
  // The WEBHOOK secret, not the API key secret. These are different values in
  // Razorpay (Dashboard → Settings → Webhooks sets the former), and this used
  // to read the key secret, so every genuine webhook would have failed
  // verification. Fail closed when it is unset: an unverifiable webhook must
  // be rejected, never waved through.
  const secret = await getSecret('razorpay_webhook_secret');
  if (!secret) {
    const err = new Error('Razorpay webhook secret is not configured — cannot verify webhook signatures.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Constant-time comparison — a plain === leaks how many leading bytes
  // matched via response-timing, letting an attacker forge a valid signature
  // byte-by-byte. Both buffers must be equal length or timingSafeEqual throws.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signature || ''), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// The key ID is publishable by design — Razorpay's own checkout script takes it
// in the browser. Only the key secret and the webhook secret are confidential,
// and neither ever leaves this service.
async function publishableKeyId() {
  return getSecret('razorpay_key_id');
}

module.exports = { createOrder, verifyWebhookSignature, publishableKeyId };
