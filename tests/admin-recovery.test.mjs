// Admin password recovery — drives the real route over HTTP with the
// Firestore, Secret Manager and SMS layers swapped for in-memory stand-ins,
// so every rule guarding the admin password is exercised without a network
// or the Firestore emulator (which needs Java 11+; this machine has 8).
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + m); };

const PHONES = ['9876500001', '9123400002']; // stand-ins — the real numbers live only in Secret Manager
const GOOD_CODE = '4321';
const NEW_PW = 'Fresh-pass-2026';

// ---------- stand-ins ----------
const store = new Map();
const snap = (key) => ({ exists: store.has(key), data: () => ({ ...store.get(key) }) });
const refFor = (key) => ({
  _key: key,
  async get() { return snap(key); },
  async set(v) { store.set(key, { ...v }); },
  async update(p) { store.set(key, { ...store.get(key), ...p }); },
  async delete() { store.delete(key); },
});
const db = {
  collection: (c) => ({ doc: (d) => refFor(`${c}/${d}`) }),
  async runTransaction(fn) {
    const writes = [];
    const out = await fn({ get: async (r) => snap(r._key), update: (r, p) => writes.push([r, p]) });
    for (const [r, p] of writes) await r.update(p);
    return out;
  },
};
const authCalls = [];
const admin = { auth: () => ({
  updateUser: async (uid, props) => { authCalls.push(['updateUser', uid, props]); },
  revokeRefreshTokens: async (uid) => { authCalls.push(['revoke', uid]); },
}) };
const audit = [];
let secrets = { 'admin-recovery-phones': PHONES.join(',') };
const texts = [];
let vidSeq = 0;

function stub(rel, exports) {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('./src/services/firestore', { db, admin, writeAuditLog: async (e) => { audit.push(e); } });
stub('./src/services/secretManager', { getSecret: async (id) => secrets[id] ?? null, KNOWN_SECRETS: {} });
stub('./src/services/messageCentralClient', {
  sendOtp: async (phone) => { texts.push(phone); return `vid-${++vidSeq}`; },
  validateOtp: async (vid, code) => vid === `vid-${vidSeq}` && code === GOOD_CODE,
});
const realLimits = require('./src/middleware/rateLimit');
const passThrough = (req, res, next) => next();
stub('./src/middleware/rateLimit', { ...realLimits, authLimiter: passThrough, recoverySendLimiter: passThrough });

const express = require('express');
const { ADMIN_FIREBASE_UID } = require('./src/middleware/adminAuth');
const app = express();
app.use(express.json());
app.use('/admin-recovery', require('./src/routes/adminRecovery'));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/admin-recovery`;

async function call(p, body) {
  const res = await fetch(base + p, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}
const leaks = (r) => PHONES.some((p) => r.text.includes(p)) || r.text.includes(NEW_PW);
const challenge = () => store.get('admin_recovery/challenge');
const pwChanges = () => authCalls.filter((c) => c[0] === 'updateUser').length;

try {
  // ---------- options ----------
  let r = await call('/options');
  ok(r.status === 200 && r.json.data.length === 2, 'lists both recovery numbers');
  // Stronger than the old assertion, which only required the numbers to be
  // MASKED (••••••0666). /options is unauthenticated, so even the last four
  // digits were free to anyone who asked — and four digits is most of what a
  // SIM-swap or a "calling about your account" pretext needs. The labels are
  // now bare ordinals: the person who owns the handsets knows which is which,
  // and a prober learns nothing at all.
  ok(r.json.data.every((o) => !/\d{4}/.test(o.label)) && !leaks(r),
    'options leak no phone digits at all, not even masked');
  secrets = {};
  r = await call('/options');
  ok(r.status === 503, 'no recovery numbers configured -> 503, nothing offered');
  secrets = { 'admin-recovery-phones': PHONES.join(',') };

  // ---------- send-otp ----------
  r = await call('/send-otp', { which: 5 });
  ok(r.status === 400 && texts.length === 0, 'out-of-range choice is refused, nothing texted');
  r = await call('/send-otp', { which: '0' });
  ok(r.status === 400 && texts.length === 0, 'non-integer choice is refused, nothing texted');
  r = await call('/send-otp', { which: 0, phone: '9000000009', mobileNumber: '9000000009' });
  ok(r.status === 200 && texts.length === 1 && texts[0] === PHONES[0],
    'code goes to the chosen server-held number, ignoring any number in the request');
  ok(!leaks(r), 'send response does not reveal the number');

  // ---------- reset: refusals ----------
  r = await call('/reset', { which: 0, otp: GOOD_CODE, newPassword: 'weak' });
  ok(r.status === 400 && challenge().attempts === 0, 'weak password refused before any attempt is spent');
  r = await call('/reset', { which: 1, otp: GOOD_CODE, newPassword: NEW_PW });
  ok(r.status === 400 && pwChanges() === 0, 'a code sent to one number cannot be redeemed as the other');
  r = await call('/reset', { which: 0, otp: '0000', newPassword: NEW_PW });
  ok(r.status === 400 && pwChanges() === 0 && challenge().attempts === 1, 'wrong code refused and counted');

  // ---------- reset: success ----------
  r = await call('/reset', { which: 0, otp: GOOD_CODE, newPassword: NEW_PW });
  const upd = authCalls.find((c) => c[0] === 'updateUser');
  ok(r.status === 200 && upd && upd[1] === ADMIN_FIREBASE_UID && upd[2].password === NEW_PW,
    'correct code sets the password on the admin uid');
  ok(authCalls.some((c) => c[0] === 'revoke' && c[1] === ADMIN_FIREBASE_UID), 'every existing admin session is revoked');
  ok(!leaks(r), 'reset response does not echo the password');
  ok(!challenge(), 'the challenge is consumed');
  r = await call('/reset', { which: 0, otp: GOOD_CODE, newPassword: NEW_PW });
  ok(r.status === 400 && pwChanges() === 1, 'the same code cannot be replayed');

  // ---------- attempt cap ----------
  await call('/send-otp', { which: 1 });
  for (let i = 0; i < 5; i++) await call('/reset', { which: 1, otp: '0000', newPassword: NEW_PW });
  r = await call('/reset', { which: 1, otp: GOOD_CODE, newPassword: NEW_PW });
  ok(r.status === 400 && pwChanges() === 1, 'after 5 wrong codes even the right one is refused');

  // ---------- expiry ----------
  await call('/send-otp', { which: 0 });
  store.set('admin_recovery/challenge', { ...challenge(), expiresAt: Date.now() - 1 });
  r = await call('/reset', { which: 0, otp: GOOD_CODE, newPassword: NEW_PW });
  ok(r.status === 400 && pwChanges() === 1, 'an expired code is refused');

  const persisted = JSON.stringify([...store.values(), ...audit]);
  ok(!persisted.includes(NEW_PW) && !PHONES.some((p) => persisted.includes(p)),
    'neither the password nor a full number is ever stored or audited');
} finally {
  server.close();
}

// ---------- the real SMS limiter: one shared budget, whatever the IP ----------
{
  const lim = express();
  lim.set('trust proxy', 1);
  lim.post('/x', realLimits.recoverySendLimiter, (req, res) => res.json({ ok: true }));
  const s = lim.listen(0);
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/x`, { method: 'POST', headers: { 'X-Forwarded-For': `10.0.0.${i + 1}` } });
    statuses.push(res.status);
  }
  s.close();
  ok(statuses.slice(0, 5).every((x) => x === 200) && statuses[5] === 429,
    'recovery texts share one budget across IPs (6th in an hour refused)');
}

console.log('\nADMIN RECOVERY: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
