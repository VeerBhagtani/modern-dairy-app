// Uber Direct API (https://developer.uber.com/docs/deliveries/introduction).
// OAuth2 client-credentials flow, then POST /v1/customers/{customer_id}/deliveries.
const { getSecret } = require('./secretManager');

const AUTH_URL = 'https://login.uber.com/oauth/v2/token';
const API_BASE = 'https://api.uber.com/v1';

async function getAccessToken() {
  const clientId = await getSecret('uber_client_id');
  const clientSecret = await getSecret('uber');
  if (!clientId || !clientSecret) {
    const err = new Error('Uber Direct is not configured yet. Add Client ID and Client Secret in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    }),
  });
  if (!res.ok) throw new Error(`Uber Direct auth failed (${res.status})`);
  const data = await res.json();
  return data.access_token;
}

async function createDelivery({ customerId, pickup, dropoff, manifest }) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}/customers/${customerId}/deliveries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pickup_address: pickup.address,
      pickup_name: pickup.name,
      pickup_phone_number: pickup.phone,
      dropoff_address: dropoff.address,
      dropoff_name: dropoff.name,
      dropoff_phone_number: dropoff.phone,
      manifest_items: manifest,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Uber Direct delivery creation failed (${res.status}): ${body.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return res.json();
}

module.exports = { createDelivery };
