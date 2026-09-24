// GoFrugal order source.
//
// STATUS: inert until credentials exist. GoFrugal API access is not enabled on
// the Modern Dairy licence (see GOFRUGAL_INTEGRATION.md), so the request and
// response shapes below follow GoFrugal's documented Advanced Web API pattern
// and are NOT verified against a live tenant.
//
// Everything tenant-specific is confined to ENDPOINT and toNormalisedOrder()
// at the bottom. When GoFrugal enables access, those are the only things that
// should need to change — nothing in the tracking, segmentation, classification
// or matching code knows this file exists.
//
// It does not fabricate a single order. With no credentials `isConfigured()`
// returns false and `syncOrders` refuses with NOT_CONFIGURED, which is the
// honest state of this integration today.

// Secret Manager is required lazily so this adapter can be loaded — and its
// response mapping tested — without a GCP client library or credentials.
function getSecret(alias) { return require('../secretManager').getSecret(alias); }

const { orderCoords } = require('./coords');
const BASE_URL = process.env.GOFRUGAL_API_BASE_URL || 'https://api.gofrugal.com/rayapi/v1';
const ORDERS_ENDPOINT = process.env.GOFRUGAL_ORDERS_ENDPOINT || '/salesOrders';
const TIMEOUT_MS = Number(process.env.GOFRUGAL_TIMEOUT_MS) || 20000;

async function creds() {
  const apiKey = await getSecret('gofrugal');
  const outletId = await getSecret('gofrugal_outlet_id');
  if (!apiKey || !outletId) return null;
  return { apiKey, outletId, companyId: await getSecret('gofrugal_company_id') };
}

async function isConfigured() {
  return (await creds()) !== null;
}

/**
 * @param {object} params { from: epochMs, to: epochMs, driverCodeToId: Map }
 */
async function fetchOrders(params = {}) {
  const c = await creds();
  if (!c) {
    const err = new Error('GoFrugal is not configured. Add the API key and outlet ID in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const from = params.from ? new Date(params.from).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const to = params.to ? new Date(params.to).toISOString().slice(0, 10) : from;

  const url = `${BASE_URL}${ORDERS_ENDPOINT}`
    + `?outletId=${encodeURIComponent(c.outletId)}`
    + (c.companyId ? `&companyId=${encodeURIComponent(c.companyId)}` : '')
    + `&fromDate=${from}&toDate=${to}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { 'X-Auth-Token': c.apiKey, Accept: 'application/json' }, signal: ac.signal });
  } catch (e) {
    const err = new Error(e.name === 'AbortError'
      ? `GoFrugal did not respond within ${TIMEOUT_MS / 1000}s.`
      : `Could not reach GoFrugal: ${e.message}`);
    err.code = e.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`GoFrugal rejected the order query (${res.status}): ${text.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  let body;
  try { body = JSON.parse(text); } catch {
    const err = new Error('GoFrugal returned a response that is not JSON.');
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  const rows = Array.isArray(body) ? body : (body.salesOrders || body.data || body.items || []);
  return rows.map((r) => toNormalisedOrder(r, params.driverCodeToId));
}

// ---- the only tenant-shaped code in this file -----------------------------
// `customerId` MUST end up equal to the customerId on our restaurant records,
// or the order can never be matched to a visit. If GoFrugal's customer key is
// something else, map it here — and if it cannot be mapped, leave it null so
// the import reports the order as unresolved rather than mis-attaching it.
function toNormalisedOrder(r, driverCodeToId) {
  const t = (v) => {
    if (!v) return null;
    const parsed = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(String(v)) ? v : `${String(v).replace(' ', 'T')}+05:30`);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const driverCode = r.deliveryBoyCode || r.driverCode || null;
  return {
    externalId: String(r.salesOrderNo ?? r.orderNo ?? r.id ?? ''),
    customerId: r.customerCode ? String(r.customerCode) : (r.customerId != null ? String(r.customerId) : null),
    placeId: null,
    assignedDriverId: driverCode && driverCodeToId ? (driverCodeToId.get(driverCode) || null) : null,
    orderedAt: t(r.orderDate || r.createdAt),
    windowStart: t(r.deliveryFrom || r.expectedDeliveryDate),
    windowEnd: t(r.deliveryTo || r.expectedDeliveryDate),
    deliveredAt: t(r.deliveredDate),
    status: r.status ? String(r.status) : null,
    // Number(null) and Number('') are 0: a record with no location became
    // (0, 0). See coords.js.
    ...orderCoords(r.latitude, r.longitude),
    raw: r,
  };
}

module.exports = {
  name: 'gofrugal',
  description: 'GoFrugal RPOS sales orders (inert until API credentials are configured)',
  isConfigured,
  fetchOrders,
  toNormalisedOrder,
};
