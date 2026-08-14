// GST verification via a GSP (GST Suvidha Provider). Targets Masters India's
// public "GST Verification" REST API v3 (https://commonapi.mastersindia.co) as
// the reference shape — most Indian GSPs (Cleartax, Surepass) use a very similar
// {client_id header + GSTIN path param} pattern, so swapping providers should
// only mean changing BASE_URL and the response field mapping below.
const { getSecret } = require('./secretManager');

const BASE_URL = process.env.GST_API_BASE_URL || 'https://commonapi.mastersindia.co/commonapis/gstsearch';

async function verifyGSTIN(gstin) {
  const apiKey = await getSecret('gst');
  if (!apiKey) {
    const err = new Error('GST verification is not configured yet. Add the GST API key in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const res = await fetch(`${BASE_URL}?gstin=${encodeURIComponent(gstin)}`, {
    headers: { 'client_id': apiKey, 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GST provider returned ${res.status}: ${body.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  const data = await res.json();
  if (!data || data.error || !data.gstin) {
    const err = new Error(data?.error || 'GSTIN not found or invalid');
    err.code = 'INVALID_GSTIN';
    throw err;
  }

  return {
    gstin: data.gstin,
    legalName: data.lgnm || data.legal_name || '',
    tradeName: data.tradeNam || data.trade_name || '',
    status: data.sts || data.status || 'Unknown',
    registrationDate: data.rgdt || null,
    address: data.pradr?.addr || null,
  };
}

module.exports = { verifyGSTIN };
