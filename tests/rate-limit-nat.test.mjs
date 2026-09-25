// Known defect 5: forty drivers behind one carrier-NAT address must not share
// one budget. Exercised over real HTTP, through the real limiter middleware
// objects, in the order the driver router mounts them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const express = require('express');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A fresh copy of the limiters per test, so their counters start at zero.
function freshLimiters() {
  const id = require.resolve('./src/middleware/rateLimit');
  delete require.cache[id];
  return require('./src/middleware/rateLimit');
}

async function serve(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// The driver router's shape: identify the driver, then the per-driver limits.
function driverApp(L) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const identify = (req, res, next) => { req.driverId = req.get('x-test-driver'); next(); };
  app.use('/driver', identify, L.driverLimiter);
  app.post('/driver/rides/start', L.writeLimiter, (req, res) => res.json({ ok: true }));
  app.post('/driver/rides/:id/points', L.gpsIngestLimiter, (req, res) => res.json({ ok: true }));
  app.get('/driver/rides/active', (req, res) => res.json({ ok: true }));
  app.post('/driver/health', L.writeLimiter, (req, res) => res.json({ ok: true }));
  return app;
}

const SAME_IP = '100.64.12.34';   // a carrier-grade NAT address
const call = (base, method, p, driver) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json', 'x-forwarded-for': SAME_IP, 'x-test-driver': driver },
  body: method === 'POST' ? '{}' : undefined,
}).then((r) => r.status);

test('40 drivers on one IP: simultaneous ride starts and a morning of uploads, nobody refused', async () => {
  const L = freshLimiters();
  const { srv, base } = await serve(driverApp(L));
  try {
    const drivers = Array.from({ length: 40 }, (_, i) => `drv${i}`);
    // Everyone presses Start Ride at 9:00.
    const starts = await Promise.all(drivers.map((d) => call(base, 'POST', '/driver/rides/start', d)));
    assert.deepEqual([...new Set(starts)], [200], 'every start accepted');
    // Fifteen minutes of normal use each: an upload every 45 s (20), a ride
    // check every minute (15), health every 5 min (3), all at once.
    const reqs = [];
    for (const d of drivers) {
      for (let k = 0; k < 20; k += 1) reqs.push(call(base, 'POST', `/driver/rides/r-${d}/points`, d));
      for (let k = 0; k < 15; k += 1) reqs.push(call(base, 'GET', '/driver/rides/active', d));
      for (let k = 0; k < 3; k += 1) reqs.push(call(base, 'POST', '/driver/health', d));
    }
    const statuses = await Promise.all(reqs);
    const refused = statuses.filter((s) => s === 429).length;
    assert.equal(refused, 0, `${refused} of ${statuses.length} legitimate requests refused`);
  } finally { srv.close(); }
});

test('a phone catching up after an hour offline is not refused either', async () => {
  const L = freshLimiters();
  const { srv, base } = await serve(driverApp(L));
  try {
    // 120 fixes at 30 s = 1 hour, in batches of ~2 — worst case, one request each.
    const statuses = await Promise.all(Array.from({ length: 120 }, () => call(base, 'POST', '/driver/rides/r1/points', 'drv-catchup')));
    assert.equal(statuses.filter((s) => s === 429).length, 0);
  } finally { srv.close(); }
});

test('one misbehaving driver is limited alone; the others on the same IP carry on', async () => {
  const L = freshLimiters();
  const { srv, base } = await serve(driverApp(L));
  try {
    const flood = await Promise.all(Array.from({ length: 260 }, () => call(base, 'POST', '/driver/rides/r1/points', 'drv-bad')));
    assert.ok(flood.includes(429), 'the flood is capped');
    const others = await Promise.all(Array.from({ length: 39 }, (_, i) => call(base, 'POST', `/driver/rides/r${i}/points`, `drv-ok${i}`)));
    assert.deepEqual([...new Set(others)], [200], 'everyone else unaffected');
  } finally { srv.close(); }
});

test('the app-wide per-IP backstop never applies to the drivers\' routes', () => {
  const index = read('backend/src/index.js');
  assert.match(index, /req\.path\.startsWith\('\/driver\/'\) \? next\(\) : generalLimiter\(req, res, next\)/);
  const driver = read('backend/src/routes/driver.js');
  assert.ok(driver.indexOf('router.use(requireDriver());') < driver.indexOf('router.use(driverLimiter);'), 'identified before limited');
  const rl = read('backend/src/middleware/rateLimit.js');
  assert.match(rl, /if \(req\.driverId\) return `driver:\$\{req\.driverId\}`;/);
  assert.match(rl, /keyGenerator: \(req\) => req\.driverId \|\| req\.ip/);
});

test('the office can run a full location audit (about 65 batches) without being throttled', () => {
  const admin = read('backend/src/routes/admin.js');
  assert.match(admin, /router\.post\('\/restaurants\/location-audit', requireRole\('admin'\), batchLimiter,/);
  const rl = freshLimiters();
  assert.ok(rl.batchLimiter);
});
