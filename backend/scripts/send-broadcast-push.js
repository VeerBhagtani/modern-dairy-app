#!/usr/bin/env node
// Relays admin broadcasts (Firestore 'broadcasts' collection, written by the
// admin website) out as real Firebase Cloud Messaging push notifications.
//
// Why this exists as a GitHub Actions cron job instead of a Cloud Function:
// sending FCM push requires a service-account credential, which can never
// live in the public admin website's client-side JS — but Cloud Functions
// (the normal place to hold that credential) requires the Blaze plan, which
// isn't available until the business has a payment method on file. This
// script holds the same credential as a GitHub Actions secret instead and
// runs on a schedule, at zero cost, using infrastructure already in place.
//
// Flow: fetch broadcasts without pushSent:true -> fetch device_tokens for
// the target audience -> send one FCM message per token -> mark the
// broadcast pushSent:true so it's never sent twice.
'use strict';
const crypto = require('crypto');

const PROJECT_ID = 'modern-dairy-pune';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.messaging',
  'https://www.googleapis.com/auth/datastore',
].join(' ');

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
  if ('timestampValue' in v) return v.timestampValue;
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
    body.fields[k] = typeof v === 'boolean' ? { booleanValue: v } : { stringValue: String(v) };
  }
  const res = await fetch(`${FIRESTORE_BASE}/${collection}/${id}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firestore patch ${collection}/${id} failed (${res.status}): ${await res.text()}`);
}

async function sendPush(token, deviceToken, title, body) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: deviceToken, notification: { title, body } } }),
  });
  if (res.ok) return { ok: true };
  const errBody = await res.text().catch(() => '');
  return { ok: false, status: res.status, body: errBody };
}

async function main() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FCM_SERVICE_ACCOUNT_JSON is not set.');
  const sa = JSON.parse(raw);
  const token = await getAccessToken(sa);

  const [broadcasts, deviceTokens] = await Promise.all([
    firestoreList(token, 'broadcasts'),
    firestoreList(token, 'device_tokens'),
  ]);

  const pending = broadcasts.filter(b => !b.pushSent);
  if (!pending.length) { console.log('No new broadcasts to push.'); return; }

  for (const b of pending) {
    const targets = deviceTokens.filter(d => b.audience === 'all' || d.audience === b.audience);
    console.log(`Broadcast ${b.id} ("${b.message}") -> ${targets.length} device(s), audience=${b.audience}`);
    let sent = 0, failed = 0;
    for (const d of targets) {
      const result = await sendPush(token, d.token, 'Modern Dairy', b.message);
      if (result.ok) sent++;
      else {
        failed++;
        console.warn(`  Failed for token ${d.id}: HTTP ${result.status} ${result.body.slice(0, 200)}`);
        // A token FCM rejects as not-found/unregistered is a dead install —
        // stop storing it so future broadcasts don't keep tripping over it.
        if (result.status === 404 || result.status === 400) {
          await firestorePatch(token, 'device_tokens', d.id, { stale: true }).catch(() => {});
        }
      }
    }
    await firestorePatch(token, 'broadcasts', b.id, { pushSent: true });
    console.log(`  Done: ${sent} sent, ${failed} failed.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
