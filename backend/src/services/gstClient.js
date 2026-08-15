// GST verification via sandbox.co.in (https://www.sandbox.co.in). Their API uses
// a two-step flow: exchange an API key + API secret for a short-lived access
// token via /authenticate, then call the GSTIN endpoint with that token.
const { getSecret } = require('./secretManager');

const BASE_URL = process.env.GST_API_BASE_URL || 'https://api.sandbox.co.in';
const API_VERSION = process.env.GST_API_VERSION || '1.0';

let tokenCache = null; // { token, fetchedAt }
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // sandbox.co.in tokens are valid ~24h; refresh a bit early

async function authenticate() {
  const apiKey = await getSecret('gst_api_key');
  const apiSecret = await getSecret('gst_api_secret');
  if (!apiKey || !apiSecret) {
    const err = new Error('GST verification is not configured yet. Add both the API key and API secret in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'x-api-secret': apiSecret,
      'x-api-version': API_VERSION,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GST provider auth failed (${res.status}): ${body.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  const data = await res.json();
  const token = data.access_token;
  if (!token) {
    const err = new Error('GST provider did not return an access token');
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  tokenCache = { token, fetchedAt: Date.now() };
  return token;
}

async function getAccessToken(forceRefresh = false) {
  if (!forceRefresh && tokenCache && Date.now() - tokenCache.fetchedAt < TOKEN_TTL_MS) {
    return tokenCache.token;
  }
  return authenticate();
}

async function verifyGSTIN(gstin) {
  const apiKey = await getSecret('gst_api_key');
  let token = await getAccessToken();

  let res = await fetch(`${BASE_URL}/gst/compliance/public/gstin/${encodeURIComponent(gstin)}`, {
    headers: {
      authorization: token,
      'x-api-key': apiKey,
      'x-api-version': API_VERSION,
    },
  });

  if (res.status === 401) {
    // Token expired/invalid — re-authenticate once and retry.
    token = await getAccessToken(true);
    res = await fetch(`${BASE_URL}/gst/compliance/public/gstin/${encodeURIComponent(gstin)}`, {
      headers: {
        authorization: token,
        'x-api-key': apiKey,
        'x-api-version': API_VERSION,
      },
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GST provider returned ${res.status}: ${body.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  const body = await res.json();
  const data = body.data;
  if (!data || !data.gstin) {
    const err = new Error(body?.message || 'GSTIN not found or invalid');
    err.code = 'INVALID_GSTIN';
    throw err;
  }

  return {
    gstin: data.gstin,
    legalName: data.legal_name || data.lgnm || '',
    tradeName: data.trade_name || data.tradeNam || '',
    status: data.gstin_status || data.sts || 'Unknown',
    registrationDate: data.date_of_registration || data.rgdt || null,
    address: data.principal_place_address || data.pradr?.addr || null,
  };
}

module.exports = { verifyGSTIN };
