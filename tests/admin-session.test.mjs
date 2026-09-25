// Office sessions, through the real requireAdmin middleware over HTTP, with
// an in-memory Firestore and a fixed signing key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const express = require('express');
const jwt = require('jsonwebtoken');
const { makeDb } = require('../tests/helpers/fake-firestore.cjs');

const KEY = 'test-signing-key-not-a-secret';

function load() {
  const db = makeDb();
  const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; return id; };
  const ids = [stub('./src/services/firestore', { db }), stub('./src/services/secretManager', { getSecret: async () => KEY })];
  const authId = require.resolve('./src/middleware/adminAuth');
  delete require.cache[authId];
  const auth = require('./src/middleware/adminAuth');
  ids.concat(authId).forEach((id) => delete require.cache[id]);
  return { db, auth };
}

async function serve(auth) {
  const app = express();
  app.use(express.json());
  app.use('/admin', auth.requireAdmin());
  app.get('/admin/dashboard', (req, res) => res.json({ ok: true, role: req.adminRole }));
  app.post('/admin/password', (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })); });
}

const tokenFor = (sub, iat = Math.floor(Date.now() / 1000)) => jwt.sign({ sub, role: 'admin', type: 'admin', iat }, KEY, { algorithm: 'HS256', expiresIn: '8h' });
const call = (base, method, p, token) => fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test('an account that must change its password can do only that, server-side', async () => {
  const { db, auth } = load();
  await db.collection('admins').doc('office').set({ role: 'admin', status: 'active', mustChangePassword: true });
  const { srv, base } = await serve(auth);
  try {
    const t = tokenFor('office');
    const blocked = await call(base, 'GET', '/admin/dashboard', t);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await call(base, 'POST', '/admin/password', t)).status, 200, 'the one thing it may do');
    // Once changed, everything opens up.
    await db.collection('admins').doc('office').set({ mustChangePassword: false }, { merge: true });
    auth.forgetAdmin('office');
    assert.equal((await call(base, 'GET', '/admin/dashboard', t)).status, 200);
  } finally { srv.close(); }
});

test('a disabled account, a changed password or a lowered role takes effect on the next request', async () => {
  const { db, auth } = load();
  await db.collection('admins').doc('a').set({ role: 'admin', status: 'active' });
  const { srv, base } = await serve(auth);
  try {
    const t = tokenFor('a', Math.floor(Date.now() / 1000) - 60);
    assert.equal((await call(base, 'GET', '/admin/dashboard', t)).body.role, 'admin');
    await db.collection('admins').doc('a').set({ role: 'viewer' }, { merge: true }); auth.forgetAdmin('a');
    assert.equal((await call(base, 'GET', '/admin/dashboard', t)).body.role, 'viewer');
    await db.collection('admins').doc('a').set({ passwordChangedAt: Date.now() }, { merge: true }); auth.forgetAdmin('a');
    assert.equal((await call(base, 'GET', '/admin/dashboard', t)).status, 401, 'the old token is dead');
    assert.equal((await call(base, 'GET', '/admin/dashboard', tokenFor('a', Math.floor(Date.now() / 1000) + 1))).status, 200, 'a new one works');
    await db.collection('admins').doc('a').set({ status: 'disabled' }, { merge: true }); auth.forgetAdmin('a');
    assert.equal((await call(base, 'GET', '/admin/dashboard', tokenFor('a', Math.floor(Date.now() / 1000) + 1))).status, 401);
    assert.equal((await call(base, 'GET', '/admin/dashboard', jwt.sign({ sub: 'a', type: 'admin' }, 'wrong-key'))).status, 401);
  } finally { srv.close(); }
});

test('a new password must differ from the current one', async () => {
  const fs = await import('fs');
  const admin = fs.readFileSync(path.join(ROOT, 'backend/src/routes/admin.js'), 'utf8');
  assert.match(admin, /if \(newPassword === currentPassword\) return bad\(res,/);
});
