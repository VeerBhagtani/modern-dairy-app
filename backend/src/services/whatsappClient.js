// Meta WhatsApp Cloud API v20.0 (https://developers.facebook.com/docs/whatsapp/cloud-api).
const { getSecret } = require('./secretManager');

const API_VERSION = 'v20.0';

async function sendTextMessage({ toPhoneE164, body, phoneNumberId }) {
  const token = await getSecret('whatsapp');
  if (!token || !phoneNumberId) {
    const err = new Error('WhatsApp is not configured yet. Add the access token and Phone Number ID in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhoneE164,
      type: 'text',
      text: { body },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const err = new Error(`WhatsApp send failed (${res.status}): ${errBody.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return res.json();
}

module.exports = { sendTextMessage };
