#!/usr/bin/env node
// Interim server-side price integrity check for orders, filling a real gap:
// the customer app writes orders directly to Firestore (see firestore.rules)
// and firestore.rules only checks that `total` is a number, not that it's
// consistent with the real catalogue price — so a forged direct Firestore
// write (or a modified/rooted client) can currently place an order at any
// price it likes. Real fix is server-side price computation once the
// backend deploys (blocked on Blaze until 2026-09-11); until then, this
// runs on the same free GitHub Actions cron pattern as
// send-broadcast-push.js and flags (does not silently trust) any order
// whose item prices don't match the live products collection, so the admin
// sees a clear warning before fulfilling it instead of finding out never.
//
// Flow: fetch products + orders needing a check -> recompute each order's
// expected line prices from the real catalogue (respecting b2b/b2c pricing)
// -> if any item's price was tampered with, mark the order
// priceMismatch:true + priceMismatchDetail, and set status to
// 'pending_confirmation' if it would otherwise auto-flow through, so a
// human looks at it. Marks priceVerified:true either way so it's never
// re-checked.
'use strict';
const crypto = require('crypto');

const PROJECT_ID = 'modern-dairy-pune';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const SCOPES = 'https://www.googleapis.com/auth/datastore';
const PRICE_TOLERANCE_PAISE = 1; // rupee rounding slack

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${claims}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromValue(val);
    return out;
  }
  return null;
}
function docToObj(doc) {
  const out = { id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields || {})) out[k] = fromValue(v);
  return out;
}

async function firestoreList(token, collection) {
  const res = await fetch(`${FIRESTORE_BASE}/${collection}?pageSize=300`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Firestore list ${collection} failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.documents || []).map(docToObj);
}

async function firestorePatch(token, collection, id, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'boolean') body.fields[k] = { booleanValue: v };
    else if (typeof v === 'number') body.fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else body.fields[k] = { stringValue: String(v) };
  }
  const res = await fetch(`${FIRESTORE_BASE}/${collection}/${id}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firestore patch ${collection}/${id} failed (${res.status}): ${await res.text()}`);
}

function expectedUnitPrice(product, vid, customerType) {
  const variant = (product?.variants || []).find(v => v.id === vid);
  if (!variant) return null;
  // The customer app tags orders with customerType 'b2b' | 'b2c' (see
  // buildOrderDoc in www/index.html) — NOT 'business'. Matching the real
  // value is what makes b2b price verification actually fire; the old
  // 'business' check never matched, so every b2b order was validated
  // against the (higher) mrp and false-flagged. Residual limitation until
  // the backend deploys: there's no server-side customer record here, so a
  // b2c buyer could still tag an order 'b2b' to be checked against the b2b
  // price — a small (b2b-vs-b2c gap) exposure, unlike the total forgery
  // closed below. Real fix is server-side pricing on Cloud Run.
  return customerType === 'b2b' ? variant.b2b : variant.mrp;
}

async function main() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FCM_SERVICE_ACCOUNT_JSON is not set.');
  const sa = JSON.parse(raw);
  const token = await getAccessToken(sa);

  const [products, orders] = await Promise.all([
    firestoreList(token, 'products'),
    firestoreList(token, 'orders'),
  ]);
  const productsById = Object.fromEntries(products.map(p => [p.id, p]));

  const pending = orders.filter(o => !o.priceVerified);
  if (!pending.length) { console.log('No new orders to price-check.'); return; }

  for (const o of pending) {
    const mismatches = [];
    // Recompute the true line-items subtotal from the live catalogue as we go,
    // so we can also catch a forged *total* — the firestore.rules only bound
    // total to 0<t<=500000 and can't sum a variable-length item list, so a
    // write with real item prices but total:1 would otherwise pass rules AND
    // (before this) be blessed priceMismatch:false. The order total can never
    // legitimately be below the sum of its catalogue-priced line items
    // (gst/delivery only add to it), so total < that sum = tampering.
    let expectedItemsSum = 0;
    for (const item of o.items || []) {
      const expected = expectedUnitPrice(productsById[item.pk], item.vid, o.customerType);
      const qty = Number(item.qty) || 0;
      if (expected == null) {
        mismatches.push(`${item.name || item.pk}: product/variant no longer exists`);
        expectedItemsSum += (Number(item.price) || 0) * qty; // fall back to charged price
        continue;
      }
      expectedItemsSum += expected * qty;
      if (Math.abs((item.price ?? 0) - expected) > PRICE_TOLERANCE_PAISE) {
        mismatches.push(`${item.name || item.pk}: charged ₹${item.price}, catalogue price is ₹${expected}`);
      }
    }
    const total = Number(o.total) || 0;
    if (total + PRICE_TOLERANCE_PAISE < expectedItemsSum) {
      mismatches.push(`order total ₹${o.total} is below the catalogue value of its items (₹${expectedItemsSum})`);
    }

    if (mismatches.length) {
      console.warn(`Order ${o.id} (${o.orderNo || o.id}) has ${mismatches.length} price mismatch(es):`);
      mismatches.forEach(m => console.warn(`  - ${m}`));
      await firestorePatch(token, 'orders', o.id, {
        priceVerified: true,
        priceMismatch: true,
        priceMismatchDetail: mismatches.join(' | ').slice(0, 1400),
        status: 'pending_confirmation',
      });
    } else {
      await firestorePatch(token, 'orders', o.id, { priceVerified: true, priceMismatch: false });
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
