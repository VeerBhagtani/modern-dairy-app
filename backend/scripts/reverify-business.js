#!/usr/bin/env node
/**
 * RE-VERIFY BUSINESS GSTINs — powers the admin panel's "Re-verify all business
 * accounts" button. Only runs when the admin has requested it
 * (reverify_control/request.requested).
 *
 * What it does: gathers every distinct GSTIN that has placed a business (b2b)
 * order (from the orders collection — that's the only place business identity
 * is recorded centrally, since customer accounts live on each device), re-checks
 * each one's CURRENT status against the GST records via sandbox.co.in, and writes
 * the results back to Firestore so the admin panel can show which businesses are
 * still active and which have had their GST registration cancelled/suspended
 * since they signed up.
 *
 * What it can NOT do: re-run the bank-account ownership check — the account
 * number is never stored (only the matched name + last 4 digits), so re-verifying
 * a bank account would require the customer to re-enter it. This job is GSTIN
 * status only.
 *
 * Secrets: FCM_SERVICE_ACCOUNT_JSON (Firestore), GST_API_KEY + GST_API_SECRET
 * (sandbox.co.in) — all already configured.
 */
'use strict';
const crypto = require('crypto');

const PROJECT_ID = 'modern-dairy-pune';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const SCOPES = 'https://www.googleapis.com/auth/datastore';
const SANDBOX = 'https://api.sandbox.co.in';

/* ── Google service-account auth ── */
function b64url(input) { return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${sig}` }) });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return (await res.json()).access_token;
}
/* ── Firestore value helpers ── */
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, toValue(val)])) } };
  return { stringValue: String(v) };
}
function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, fromValue(val)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  return null;
}
async function getDoc(token, docPath) {
  const res = await fetch(`${FIRESTORE_BASE}/${docPath}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get ${docPath} failed (${res.status})`);
  return Object.fromEntries(Object.entries((await res.json()).fields || {}).map(([k, v]) => [k, fromValue(v)]));
}
async function patchDoc(token, docPath, fields) {
  const [coll, ...rest] = docPath.split('/');
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FIRESTORE_BASE}/${encodeURIComponent(coll)}/${encodeURIComponent(rest.join('/'))}?${mask}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!res.ok) throw new Error(`patch ${docPath} failed (${res.status}): ${await res.text()}`);
}
async function listOrders(token) {
  /* Only b2b orders can contribute a business GSTIN, so let Firestore do that
     filtering instead of dragging every retail order across the wire to throw
     it away here. Two reasons this matters beyond tidiness:
       · cost — this used to read the entire orders collection, growing with
         every order ever placed;
       · correctness — it gave up silently after 50 pages and returned a
         partial list, so once the collection passed ~15,000 documents some
         businesses simply stopped being re-verified, with nothing in the
         output saying so. Truncation is now loud, and much harder to reach. */
  const out = [];
  let cursorId = null;
  const MAX_PAGES = 50, BATCH = 300;
  for (let p = 0; p < MAX_PAGES; p++) {
    const structuredQuery = {
      from: [{ collectionId: 'orders' }],
      where: { fieldFilter: { field: { fieldPath: 'customerType' }, op: 'EQUAL', value: { stringValue: 'b2b' } } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: BATCH,
    };
    if (cursorId) {
      structuredQuery.startAt = {
        values: [{ referenceValue: `projects/${PROJECT_ID}/databases/(default)/documents/orders/${cursorId}` }],
        before: false,
      };
    }
    const res = await fetch(`${FIRESTORE_BASE}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }),
    });
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`list b2b orders failed (${res.status}): ${await res.text()}`);
    const rows = await res.json();
    const docs = rows.map(r => r.document).filter(Boolean);
    for (const d of docs) out.push(Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromValue(v)])));
    if (docs.length < BATCH) return out;
    cursorId = docs[docs.length - 1].name.split('/').pop();
  }
  // Do not return a silently partial list — the caller would report a clean
  // re-verification over businesses it never actually looked at.
  throw new Error(`Stopped after ${MAX_PAGES} pages of b2b orders (${out.length}). Refusing to report a partial re-verification — raise MAX_PAGES.`);
}

/* ── sandbox.co.in GST ── */
async function gstAuthenticate() {
  const res = await fetch(`${SANDBOX}/authenticate`, { method: 'POST', headers: { 'x-api-key': process.env.GST_API_KEY, 'x-api-secret': process.env.GST_API_SECRET, 'x-api-version': '1.0' } });
  const d = await res.json().catch(() => ({}));
  const token = d.access_token || d.data?.access_token;
  if (!res.ok || !token) throw new Error('GST authenticate failed (' + res.status + ')');
  return token;
}
async function gstVerify(gstin, token) {
  const res = await fetch(`${SANDBOX}/gst/compliance/public/gstin/verify`, {
    method: 'POST', headers: { authorization: token, 'x-api-key': process.env.GST_API_KEY, 'x-api-version': '1.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({ gstin }),
  });
  const body = await res.json().catch(() => ({}));
  const data = body?.data?.data;
  if (!res.ok || !data) return { ok: false, status: 'Lookup failed', valid: false };
  return { ok: true, status: data.status || 'Unknown', legalName: data.legalName || '', valid: data.validGstin !== false };
}

async function main() {
  const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.client_email) throw new Error('FCM_SERVICE_ACCOUNT_JSON not set.');
  if (!process.env.GST_API_KEY || !process.env.GST_API_SECRET) throw new Error('GST_API_KEY / GST_API_SECRET not set.');
  const token = await getAccessToken(sa);

  const req = (await getDoc(token, 'reverify_control/request')) || {};
  if (!req.requested) { console.log('No re-verification requested — nothing to do.'); return; }
  console.log('Re-verification requested by', req.requestedBy || 'admin');

  // Distinct business GSTINs from orders (latest name/phone seen per GSTIN).
  const orders = await listOrders(token);
  const byGstin = new Map();
  for (const o of orders) {
    if (o.customerType !== 'b2b' || !o.gstin) continue;
    const g = String(o.gstin).toUpperCase().trim();
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) continue;
    const prev = byGstin.get(g);
    if (!prev || String(o.placedAt || '') > String(prev.placedAt || '')) byGstin.set(g, { gstin: g, name: o.name || o.company || '', phone: o.phone || '', placedAt: o.placedAt || '' });
  }
  const businesses = [...byGstin.values()];
  console.log(`${businesses.length} distinct business GSTIN(s) to re-check.`);
  if (!businesses.length) {
    await patchDoc(token, 'reverify_control/request', { requested: false, lastResult: 'No business GSTINs found in orders.', lastAt: new Date().toISOString(), lastCount: 0, lastFlagged: 0 });
    return;
  }

  const gstToken = await gstAuthenticate();
  const results = [];
  let flagged = 0;
  for (const b of businesses) {
    let v;
    try { v = await gstVerify(b.gstin, gstToken); }
    catch (e) { v = { ok: false, status: 'Lookup failed', valid: false }; }
    const active = v.valid && /active/i.test(v.status);
    if (!active) flagged++;
    results.push({ gstin: b.gstin, name: b.name, phone: b.phone, status: v.status, legalName: v.legalName || '', active });
    await new Promise(r => setTimeout(r, 400)); // be gentle on the metered API
  }
  results.sort((a, b) => Number(a.active) - Number(b.active)); // problems first

  await patchDoc(token, 'reverify_control/result', {
    at: new Date().toISOString(), total: results.length, flagged,
    businesses: results.slice(0, 500),
  });
  await patchDoc(token, 'reverify_control/request', {
    requested: false, lastAt: new Date().toISOString(), lastCount: results.length, lastFlagged: flagged,
    lastResult: `${results.length} checked, ${flagged} need attention (GST not active).`,
  });
  console.log(`Done: ${results.length} checked, ${flagged} flagged (GST not active).`);
}

main().catch(async (e) => {
  console.error('reverify-business failed:', e);
  try {
    const token = await getAccessToken(JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON));
    await patchDoc(token, 'reverify_control/request', { requested: false, lastResult: 'error: ' + String(e.message || e).slice(0, 150), lastAt: new Date().toISOString() });
  } catch (_) {}
  process.exit(1);
});
