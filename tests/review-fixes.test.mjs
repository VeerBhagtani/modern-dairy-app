// Fixes from the full-codebase review. Each test names the failure it guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'backend', 'x.cjs'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { needsCalc, keepCurrent } = require_(path.join(ROOT, 'backend/src/services/freshness.js'));
const { orderCoords } = require_(path.join(ROOT, 'backend/src/services/orderSource/coords.js'));
const { asyncRouter } = require_(path.join(ROOT, 'backend/src/middleware/asyncRoutes.js'));
const express = require_('express');

const NOW = Date.parse('2026-09-24T12:00:00+05:30');
const MIN = 60 * 1000;

// ── order coordinates ──────────────────────────────────────────────────────

test('a blank location in an order file is "no location", not (0, 0)', () => {
  // Number('') is 0: every order without coordinates was stored in the
  // Atlantic, matched nothing, and raised an alert on every ride.
  for (const [lat, lng] of [['', ''], [null, null], [undefined, undefined], ['  ', ' '], ['0', '0'], [0, 0]]) {
    assert.deepEqual(orderCoords(lat, lng), { lat: null, lng: null }, `${JSON.stringify([lat, lng])}`);
  }
  assert.deepEqual(orderCoords('18.5204', '73.8567'), { lat: 18.5204, lng: 73.8567 });
  assert.deepEqual(orderCoords('95', '73'), { lat: null, lng: null }, 'out of range');
  assert.deepEqual(orderCoords('18.5', ''), { lat: null, lng: null }, 'half a location is no location');
});

test('both order sources use the same rule', () => {
  for (const f of ['manual.js', 'gofrugal.js']) {
    assert.match(read(`backend/src/services/orderSource/${f}`), /orderCoords\(/, f);
  }
  const g = require_(path.join(ROOT, 'backend/src/services/orderSource/gofrugal.js'));
  const o = g.toNormalisedOrder({ salesOrderNo: 1, latitude: null, longitude: '' }, new Map());
  assert.equal(o.lat, null);
  assert.equal(o.lng, null);
});

// ── calculation bookkeeping ────────────────────────────────────────────────

test('a ride whose raw GPS was deleted is never recalculated into zeros', () => {
  const ride = { status: 'stopped', pointCount: 900, processedAt: NOW - 90 * 24 * 60 * MIN,
    lastUploadAt: NOW - 89 * 24 * 60 * MIN, rawGpsDeletedAt: NOW - 10 * MIN };
  assert.equal(needsCalc(ride, NOW), false);
  assert.match(read('backend/src/services/rideProcessing.js'), /if \(ride\.rawGpsDeletedAt\)/,
    'and a manual recalculation refuses it too');
});

test('a batch uploaded while a calculation ran is picked up afterwards', () => {
  // Read points at T0, a batch lands at T1, the result is saved at T2. Judged
  // by the save time the batch looked already counted, and was never added.
  const T0 = NOW - 10 * MIN; const T1 = NOW - 9 * MIN; const T2 = NOW - 8 * MIN;
  const ride = { status: 'stopped', pointCount: 900, processedInputsAt: T0, lastUploadAt: T1, processedAt: T2 };
  assert.equal(needsCalc(ride, NOW), true);
});

test('the upload time is stamped after the points are stored', () => {
  // Stamped before, a calculation reading between the two could miss the
  // batch while seeing a "newer" result.
  const repo = read('backend/src/services/repo.js');
  const fn = repo.slice(repo.indexOf('async function ingestPoints'), repo.indexOf('async function loadPoints'));
  assert.ok(fn.indexOf('await writer.close()') < fn.indexOf('lastUploadAt: Date.now()'));
});

test('a ride that keeps failing is retried later, not on every look, and not first', async () => {
  const failing = { id: 'bad', status: 'stopped', pointCount: 5, calcFailedAt: NOW - 5 * MIN, lastUploadAt: NOW - 60 * MIN };
  assert.equal(needsCalc(failing, NOW), false, 'backs off');
  assert.equal(needsCalc({ ...failing, calcFailedAt: NOW - 31 * MIN }, NOW), true, 'then tries again');
  assert.equal(needsCalc({ ...failing, lastUploadAt: NOW - 1 * MIN }, NOW), true, 'or at once when new points arrive');

  const order = [];
  await keepCurrent([
    { id: 'bad', status: 'stopped', pointCount: 5, calcFailedAt: NOW - 40 * MIN },
    { id: 'good', status: 'stopped', pointCount: 5 },
  ], { processOne: async (id) => { order.push(id); }, now: () => NOW });
  assert.deepEqual(order, ['good', 'bad'], 'a ride that has failed before goes last');
});

test('a failure is recorded, and a ride another request is calculating is not a failure', async () => {
  const marked = [];
  const out = await keepCurrent([
    { id: 'a', status: 'stopped', pointCount: 5 },
    { id: 'b', status: 'stopped', pointCount: 5 },
  ], {
    processOne: async (id) => {
      if (id === 'a') throw Object.assign(new Error('busy'), { code: 'BUSY' });
      throw new Error('bad data');
    },
    markFailed: (id, msg) => { marked.push([id, msg]); },
    now: () => NOW,
  });
  assert.equal(out.busy, 1);
  assert.deepEqual(out.failed.map((f) => f.rideId), ['b']);
  assert.deepEqual(marked, [['b', 'bad data']]);
});

test('two calculations of one ride cannot run at once', () => {
  const svc = read('backend/src/services/rideProcessing.js');
  assert.match(svc, /let token = await repo\.acquireCalcLease\(rideId\)/);
  assert.match(svc, /finally \{\s*await repo\.releaseCalcLease\(rideId, token\)/);
});

test('a running ride raises no end-of-day alerts', () => {
  // "Unmatched delivery" at ten in the morning, about deliveries not reached
  // yet, re-raised on every recalculation.
  const svc = read('backend/src/services/rideProcessing.js');
  assert.match(svc, /if \(ride\.status !== 'active'\) \{\s*const existing = await repo\.openAlerts/);
});

// ── requests that never got an answer ──────────────────────────────────────

test('an async handler that throws gets a 500, not silence', async () => {
  const app = express();
  const router = asyncRouter(express.Router());
  router.get('/boom', async () => { throw new Error('firestore contention'); });
  router.get('/fine', async (req, res) => res.json({ ok: true }));
  app.use(router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ success: false }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${base}/boom`, { signal: ctrl.signal });
    clearTimeout(timer);
    assert.equal(res.status, 500);
    assert.equal((await fetch(`${base}/fine`)).status, 200);
  } finally {
    server.close();
  }
});

test('both route files use the async-safe router', () => {
  for (const f of ['driver.js', 'admin.js']) {
    assert.match(read(`backend/src/routes/${f}`), /const router = asyncRouter\(require\('express'\)\.Router\(\)\);/, f);
  }
});

// ── one budget per phone, not per network ──────────────────────────────────

test('phones are not limited per network address', () => {
  const idx = read('backend/src/index.js');
  assert.match(idx, /req\.path\.startsWith\('\/driver\/'\) \? next\(\) : generalLimiter/);
  const drv = read('backend/src/routes/driver.js');
  assert.match(drv, /router\.post\('\/refresh', refreshLimiter/);
  assert.match(drv, /router\.use\(requireDriver\(\)\);\nrouter\.use\(driverLimiter\);/);
});

// ── yesterday's points stay yesterday's ────────────────────────────────────

test('points recorded before a ride began are refused from it, by name', () => {
  const drv = read('backend/src/routes/driver.js');
  assert.match(drv, /error: 'recorded before this ride started'/);
  // And a batch made only of after-stop points is answered with them named,
  // not with a bare "ride stopped" that left them queued for ever.
  assert.doesNotMatch(drv, /code: 'RIDE_STOPPED'/);
});

test('the phone keeps each queued point with its ride and sends it there', () => {
  const app = read('app/www/app.js');
  assert.match(app, /rideId: state\.rideId \|\| null,\s*clientPointId: nextPointId\(\)/);
  assert.match(app, /var ride = p\.rideId \|\| state\.rideId;/);
  assert.match(app, /apiFetch\('\/driver\/rides\/' \+ ride \+ '\/points'/);
});

test('an office review is always applied, even if the ride was busy when it was saved', () => {
  // Saved while another calculation held the ride, a review used to wait for
  // new GPS points before anything recalculated the ride — possibly never.
  const ride = { status: 'stopped', pointCount: 900, processedInputsAt: NOW - 30 * MIN, processedAt: NOW - 29 * MIN,
    lastUploadAt: NOW - 60 * MIN, inputsChangedAt: NOW - 1 * MIN };
  assert.equal(needsCalc(ride, NOW), true);
  const repo = read('backend/src/services/repo.js');
  assert.match(repo, /batch\.update\(C\.rides\(\)\.doc\(rideId\), \{ inputsChangedAt: Date\.now\(\) \}\);/, 'addReview marks the ride');
  assert.match(repo, /await markInputsChanged\(doc\.data\(\)\.rideId\);/, 'revertReview marks the ride');
  assert.match(read('backend/src/routes/driver.js'), /await repo\.markInputsChanged\(rideId\);/, 'a personal declaration marks the ride');
  assert.match(read('backend/src/routes/admin.js'), /processOne\(rideId, \{ waitMs: 15000 \}\)/, 'and the review waits its turn');
});
