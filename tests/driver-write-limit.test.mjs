// Driver writes are counted per driver, not per network address.
//
// They were counted per IP. Indian mobile carriers put thousands of phones
// behind a few shared addresses, and the depot Wi-Fi is one address for
// everyone on it, so the whole fleet shared one budget of 30 writes per 15
// minutes: a few drivers pressing Start Ride together locked out the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'backend', 'x.cjs'));
const { writeKey, writeLimiter } = require_(path.join(ROOT, 'backend/src/middleware/rateLimit.js'));
const express = require_('express');

test('two drivers on one network address have separate budgets', () => {
  const sameIp = '100.64.0.1';
  assert.notEqual(writeKey({ driverId: 'a', ip: sameIp }), writeKey({ driverId: 'b', ip: sameIp }));
});

test('an identity never shares a key with a bare address or another kind of account', () => {
  // Prefixed, so a driver id that happens to equal an admin id or an IP string
  // cannot land in someone else's bucket.
  const keys = [
    writeKey({ driverId: 'x', ip: 'x' }),
    writeKey({ userId: 'x', ip: 'x' }),
    writeKey({ adminId: 'x', ip: 'x' }),
    writeKey({ ip: 'x' }),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test('one driver reaching the limit does not stop another on the same address', async () => {
  const app = express();
  app.use((req, _res, next) => { req.driverId = req.headers['x-driver']; next(); });
  app.post('/w', writeLimiter, (_req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/w`;
    const hit = (d) => fetch(url, { method: 'POST', headers: { 'x-driver': d } }).then((r) => r.status);
    let last;
    for (let i = 0; i < 31; i += 1) last = await hit('driver-a');
    assert.equal(last, 429, 'driver A is still limited');
    assert.equal(await hit('driver-b'), 200, 'driver B, same address, is not');
  } finally {
    server.close();
  }
});
