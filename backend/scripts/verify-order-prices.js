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
// Statuses from which pulling an order back to pending_confirmation is still
// meaningful. Past these it is on a van or delivered, and rewriting its status
// would misrepresent where the goods actually are.
const PRE_FULFILMENT = ['placed', 'confirmed', 'pending_confirmation', 'packed'];
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

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

// Pages through a whole collection. Used for `products`, which is small and
// bounded. It is deliberately NOT used for `orders` any more — see
// listUnverifiedOrders below.
const MAX_PAGES = 50;
async function firestoreList(token, collection) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${FIRESTORE_BASE}/${encodeURIComponent(collection)}?pageSize=300`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore list ${collection} failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    out.push(...(data.documents || []).map(docToObj));
    pageToken = data.nextPageToken || '';
    if (!pageToken) return out;
  }
  console.warn(`Stopped paging ${collection} at ${MAX_PAGES} pages (${out.length} docs) — raise MAX_PAGES if this is legitimate.`);
  return out;
}

/* Fetches ONLY the orders that still need checking, with a query.
 *
 * This used to list the entire orders collection and filter `!priceVerified`
 * in memory, behind a 50-page x 300-doc ceiling. Two problems, one of them a
 * security hole rather than a scaling nit:
 *
 *   · Firestore returns documents in id order, so once the collection passed
 *     15,000 documents, everything beyond the ceiling was never fetched, never
 *     price-checked, and never retried — the forged-price defence quietly
 *     stopped covering new orders. The previous fix raised the ceiling; a
 *     ceiling is the wrong shape of answer.
 *   · It re-read every order ever placed, every three minutes. That is 480
 *     full scans a day, growing linearly and billed per document read.
 *
 * A structured query does the filtering server-side, so the work is
 * proportional to the backlog instead of to history, and there is no ceiling
 * to outgrow. No composite index is required: an equality filter on one field
 * ordered by __name__ is served by Firestore's automatic single-field index,
 * and declaring a composite one for it is rejected at deploy time as redundant.
 */
/* ONE-TIME BACKFILL, and why it has to exist.
 *
 * The query below filters `priceVerified == false`. Firestore only returns
 * documents that HAVE the field — a missing field does not equal false, it is
 * simply not indexed for that filter. Every order written before the client
 * started stamping priceVerified therefore has no such field and is invisible
 * to the query. The old code scanned everything and filtered
 * `!o.priceVerified` in memory, which did catch them, so switching to a query
 * silently dropped those orders out of the price check entirely.
 *
 * There is no "where field is missing" query in Firestore, so finding them
 * requires exactly one full scan. This does that scan once, stamps
 * priceVerified:false on anything lacking it, and records completion so it
 * never runs again. Self-retiring: after the first successful pass this costs
 * a single document read per run.
 */
const BACKFILL_DOC = 'audit_control/price_verified_backfill';
async function backfillMissingPriceVerified(token) {
  const marker = await getDocFields(token, BACKFILL_DOC);
  if (marker && marker.done === true) return;

  console.log('Back-filling priceVerified on pre-existing orders (one time)...');
  let scanned = 0, stamped = 0, pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${FIRESTORE_BASE}/orders?pageSize=300`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`backfill list failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    for (const raw of data.documents || []) {
      scanned++;
      // Read the RAW fields: docToObj would turn a missing field and an
      // explicit false into the same thing.
      if (raw.fields && Object.prototype.hasOwnProperty.call(raw.fields, 'priceVerified')) continue;
      const id = raw.name.split('/').pop();
      await firestorePatch(token, 'orders', id, { priceVerified: false });
      stamped++;
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) {
      await firestorePatch(token, 'audit_control', 'price_verified_backfill', { done: true, scanned, stamped, at: new Date().toISOString() });
      console.log(`Backfill complete: ${scanned} order(s) scanned, ${stamped} stamped.`);
      return;
    }
  }
  // Ran out of pages without finishing. Deliberately NOT marked done, so the
  // next run picks up where a bigger MAX_PAGES can finish the job.
  console.warn(`Backfill incomplete after ${MAX_PAGES} pages (${scanned} scanned, ${stamped} stamped) — it will resume next run. Raise MAX_PAGES if this persists.`);
}

async function getDocFields(token, docPath) {
  const res = await fetch(`${FIRESTORE_BASE}/${docPath}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get ${docPath} failed (${res.status})`);
  const d = await res.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromValue(v)]));
}

const ORDER_BATCH = 300;
async function listUnverifiedOrders(token) {
  const out = [];
  let cursorId = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const structuredQuery = {
      from: [{ collectionId: 'orders' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'priceVerified' },
          op: 'EQUAL',
          value: { booleanValue: false },
        },
      },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: ORDER_BATCH,
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
    if (!res.ok) throw new Error(`Firestore runQuery orders failed (${res.status}): ${await res.text()}`);
    const rows = await res.json();
    const docs = rows.map(r => r.document).filter(Boolean).map(docToObj);
    out.push(...docs);
    if (docs.length < ORDER_BATCH) return out;
    cursorId = docs[docs.length - 1].id;
  }
  console.warn(`Stopped after ${MAX_PAGES} pages of unverified orders (${out.length}). Backlog is unusually large — investigate.`);
  return out;
}

async function firestorePatch(token, collection, id, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'boolean') body.fields[k] = { booleanValue: v };
    else if (typeof v === 'number') body.fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else body.fields[k] = { stringValue: String(v) };
  }
  // encodeURIComponent on the doc id is load-bearing, not cosmetic: these ids
  // are attacker-controlled. A device_tokens doc id IS the FCM token the
  // client chose, and an order can be created at a client-chosen id via the
  // Firestore REST createDocument?documentId= parameter. Firestore ids may
  // legally contain `?` and `&`, so an unescaped id let a caller append their
  // own query parameters to this PATCH — including extra
  // updateMask.fieldPaths entries, which delete fields absent from the body.
  const res = await fetch(`${FIRESTORE_BASE}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?${mask}`, {
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

  // Must run BEFORE the query: it is what makes pre-existing orders visible
  // to it at all.
  await backfillMissingPriceVerified(token);

  const [products, pending] = await Promise.all([
    firestoreList(token, 'products'),
    listUnverifiedOrders(token),
  ]);
  const productsById = Object.fromEntries(products.map(p => [p.id, p]));

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

    // A b2b tag is what selects the (lower) wholesale price above, and until
    // there is a server-side customer record it is just a string the client
    // wrote. Flagging a b2b order with no structurally valid GSTIN catches the
    // cheapest version of claiming wholesale rates without a business.
    if (o.customerType === 'b2b' && !GSTIN_RE.test(String(o.gstin || '').toUpperCase())) {
      mismatches.push('order claims business (b2b) pricing but carries no valid GSTIN');
    }

    if (mismatches.length) {
      console.warn(`Order ${o.id} (${o.orderNo || o.id}) has ${mismatches.length} price mismatch(es):`);
      mismatches.forEach(m => console.warn(`  - ${m}`));
      const patch = {
        priceVerified: true,
        priceMismatch: true,
        priceMismatchDetail: mismatches.join(' | ').slice(0, 1400),
      };
      // Only pull an order BACK to pending_confirmation if it hasn't already
      // moved past the point where that makes sense. This used to be
      // unconditional, so a mismatch found on an order that was already packed
      // — or delivered — dragged it backwards through its own lifecycle and
      // confused the admin list about what was actually on the van.
      if (PRE_FULFILMENT.includes(o.status)) {
        patch.status = 'pending_confirmation';
      } else {
        console.warn(`  (order is already '${o.status}' — flagged but status left alone)`);
      }
      await firestorePatch(token, 'orders', o.id, patch);
    } else {
      await firestorePatch(token, 'orders', o.id, { priceVerified: true, priceMismatch: false });
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
