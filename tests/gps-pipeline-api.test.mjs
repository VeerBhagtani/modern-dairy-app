// The GPS pipeline end to end, through the real driver and office APIs over
// HTTP, with an in-memory Firestore: phone upload → validation → storage →
// live position → tracking status → kilometre calculation → dashboard.
//
// Scenarios (named as in the production-readiness brief):
//   A normal journey · B internet interruption · E duplicate upload ·
//   F out-of-order upload · I ride stopped remotely · J 40 drivers at once ·
//   plus wrong phone clocks, authentication, and the tracking states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const express = require('express');
const jwt = require('jsonwebtoken');
const { makeDb, FieldValue } = require('../tests/helpers/fake-firestore.cjs');
const { haversineM } = require('./src/drivers/geo');

const KEY = 'test-signing-key-not-a-secret';
const SRC = path.join(ROOT, 'backend', 'src') + path.sep;

async function boot() {
  for (const id of Object.keys(require.cache)) if (id.startsWith(SRC)) delete require.cache[id];
  const db = makeDb();
  const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  stub('./src/services/firestore', { db, admin: { firestore: { FieldValue } }, FieldValue });
  stub('./src/services/secretManager', {
    getSecret: async (k) => (/jwt|signing/.test(k) ? KEY : null), setSecret: async () => {}, secretStatus: async () => ({}), KNOWN_SECRETS: {},
  });
  const { router: driverRoutes } = require('./src/routes/driver');
  const { router: adminRoutes } = require('./src/routes/admin');
  const { requireAdmin } = require('./src/middleware/adminAuth');
  const { requestId } = require('./src/services/log');
  const repo = require('./src/services/repo');
  const rideProcessing = require('./src/services/rideProcessing');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(requestId());
  app.use('/driver', driverRoutes);
  app.use('/admin', requireAdmin(), adminRoutes);
  app.use((err, req, res, next) => { res.status(500).json({ success: false, message: String(err.message || err) }); });   // eslint-disable-line no-unused-vars
  await db.collection('admins').doc('office').set({ role: 'admin', status: 'active', name: 'Office' });
  const adminToken = jwt.sign({ sub: 'office', role: 'admin', type: 'admin', iat: Math.floor(Date.now() / 1000) }, KEY, { algorithm: 'HS256', expiresIn: '8h' });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (method, p, body, token) => fetch(base + p, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const quiet = console.error; const quietLog = console.log;
  console.error = () => {}; console.log = () => {};   // structured logs are noise here
  return {
    db, repo, rideProcessing, call, adminToken,
    admin: (method, p, body) => call(method, p, body, adminToken),
    close: () => { srv.close(); console.error = quiet; console.log = quietLog; },
  };
}

async function driver(t, name, n) {
  const reg = await t.call('POST', '/driver/register', { name, deviceId: `dev-${n}-abcdef` });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const token = reg.body.data.accessToken;
  const start = await t.call('POST', '/driver/rides/start', { deviceId: `dev-${n}-abcdef` }, token);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  // Started two hours ago, so the test's fixes (from the last few minutes) are
  // inside the ride, as a real phone's are.
  await t.db.collection('rides').doc(start.body.data.rideId).set({ startedAt: Date.now() - 2 * 3600e3 }, { merge: true });
  return { id: reg.body.data.driver.id, token, rideId: start.body.data.rideId, n };
}

// A drive east along one street: a fix every 25 m, every 4 s.
const LAT = 18.50; const LNG = 73.86; const K = 111320 * Math.cos(LAT * Math.PI / 180);
function drive({ prefix, t0, from = 0, count, stepM = 25, dt = 4000, lat = LAT }) {
  return Array.from({ length: count }, (_, i) => ({
    clientPointId: `${prefix}:${String(from + i).padStart(6, '0')}`,
    lat, lng: LNG + ((from + i) * stepM) / K, deviceTs: t0 + (from + i) * dt, accuracyM: 6, speedMps: stepM / (dt / 1000),
  }));
}
const upload = (t, d, points, extra = {}) => t.call('POST', `/driver/rides/${d.rideId}/points`, { points, sentAt: Date.now(), ...extra }, d.token);

test('A: a normal journey is stored, moves the live position, is LIVE, and its kilometres are calculated', async () => {
  const t = await boot();
  try {
    const d = await driver(t, 'Ravi', 1);
    const t0 = Date.now() - 200 * 4000;
    const pts = drive({ prefix: 'a', t0, count: 200 });
    for (let i = 0; i < 200; i += 50) {
      const r = await upload(t, d, pts.slice(i, i + 50));
      assert.equal(r.status, 200);
      assert.equal(r.body.data.accepted.length, 50);
    }
    const ride = await t.repo.getRide(d.rideId);
    assert.equal(ride.pointCount, 200);
    const live = (await t.db.collection('driver_live').doc(d.id).get()).data();
    assert.equal(live.deviceTs, pts[199].deviceTs, 'the marker is at the newest fix');
    const dash = await t.admin('GET', '/admin/dashboard');
    assert.equal(dash.status, 200, JSON.stringify(dash.body));
    const row = dash.body.data.drivers.find((x) => x.driverId === d.id);
    assert.equal(row.tracking.state, 'LIVE');
    assert.equal(row.locationState, 'live');
    // The calculation (run by the dashboard look above) matches the route.
    const expected = haversineM(pts[0], pts[199]);
    const proc = await t.repo.loadProcessing(d.rideId, { withSegments: false });
    assert.ok(proc, 'calculated');
    assert.ok(Math.abs(proc.distance.metres.measured - expected) < 5, `${proc.distance.metres.measured} vs ${expected}`);
    assert.equal(row.today.calcState, 'ok');
    assert.ok(row.today.calculatedAt);
  } finally { t.close(); }
});

test('B: fixes recorded offline arrive later with their own times, once each, and the distance is recalculated', async () => {
  const t = await boot();
  try {
    const d = await driver(t, 'Sunil', 2);
    const t0 = Date.now() - 400 * 4000;
    const all = drive({ prefix: 'b', t0, count: 300 });
    await upload(t, d, all.slice(0, 100));
    await t.rideProcessing.processOne(d.rideId);
    const before = (await t.repo.loadProcessing(d.rideId, { withSegments: false })).distance.metres.measured;
    // 200 fixes held on the phone while offline, sent in one go.
    const late = await upload(t, d, all.slice(100));
    assert.equal(late.body.data.accepted.length, 200);
    const stored = (await t.db.collection('rides').doc(d.rideId).collection('gps_raw').doc(all[150].clientPointId).get()).data();
    assert.equal(stored.deviceTs, all[150].deviceTs, 'the original time is kept');
    assert.ok(stored.serverTs > stored.deviceTs, 'with the time the server received it');
    const ride = await t.repo.getRide(d.rideId);
    assert.ok(t.rideProcessing && (ride.lastUploadAt > ride.processedInputsAt), 'the ride is marked as needing a recalculation');
    await t.rideProcessing.processOne(d.rideId);
    const after = (await t.repo.loadProcessing(d.rideId, { withSegments: false })).distance.metres.measured;
    assert.ok(Math.abs(after - haversineM(all[0], all[299])) < 5, `${after}`);
    assert.ok(after > before * 2.5, 'the late kilometres are added, the earlier ones kept');
    assert.equal(ride.pointCount, 300);
  } finally { t.close(); }
});

test('E: the same upload three times stores each fix once and does not add a metre', async () => {
  const t = await boot();
  try {
    const d = await driver(t, 'Imran', 3);
    const pts = drive({ prefix: 'e', t0: Date.now() - 100 * 4000, count: 80 });
    await upload(t, d, pts);
    await t.rideProcessing.processOne(d.rideId);
    const once = (await t.repo.loadProcessing(d.rideId, { withSegments: false })).distance.metres.measured;
    const again = await upload(t, d, pts);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.duplicates, 80, 'reported as duplicates');
    await upload(t, d, pts.slice(10, 40));
    assert.equal((await t.repo.getRide(d.rideId)).pointCount, 80);
    await t.rideProcessing.processOne(d.rideId);
    await t.rideProcessing.processOne(d.rideId);   // the same calculation twice
    assert.equal((await t.repo.loadProcessing(d.rideId, { withSegments: false })).distance.metres.measured, once);
  } finally { t.close(); }
});

test('F: batches arriving in the wrong order give the same route and distance as the right order', async () => {
  const t = await boot();
  try {
    const d1 = await driver(t, 'Order One', 4);
    const d2 = await driver(t, 'Order Two', 5);
    const t0 = Date.now() - 200 * 4000;
    const a = drive({ prefix: 'f1', t0, count: 150 });
    const b = drive({ prefix: 'f2', t0, count: 150 });
    for (let i = 0; i < 150; i += 30) await upload(t, d1, a.slice(i, i + 30));
    for (const i of [120, 0, 60, 90, 30]) await upload(t, d2, b.slice(i, i + 30));
    await t.rideProcessing.processOne(d1.rideId);
    await t.rideProcessing.processOne(d2.rideId);
    const m1 = (await t.repo.loadProcessing(d1.rideId, { withSegments: false })).distance.metres;
    const m2 = (await t.repo.loadProcessing(d2.rideId, { withSegments: false })).distance.metres;
    assert.equal(m2.measured, m1.measured);
    // The marker never jumped back to an older batch.
    const live = (await t.db.collection('driver_live').doc(d2.id).get()).data();
    assert.equal(live.deviceTs, b[149].deviceTs);
  } finally { t.close(); }
});

test('I: a ride stopped by the office: late fixes from before the stop are kept, later ones refused by name, no new ride', async () => {
  const t = await boot();
  try {
    const d = await driver(t, 'Prakash', 6);
    const t0 = Date.now() - 100 * 4000;
    const pts = drive({ prefix: 'i', t0, count: 100 });
    await upload(t, d, pts.slice(0, 40));
    // The driver cannot stop it.
    const own = await t.call('POST', `/driver/rides/${d.rideId}/stop`, { reason: 'done' }, d.token);
    assert.ok(own.status >= 400, 'the driver is refused');
    // A stale screen naming the wrong driver is refused.
    const wrong = await t.admin('POST', `/admin/rides/${d.rideId}/stop`, { reason: 'End of shift', driverId: 'someone-else' });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'WRONG_DRIVER');
    const stopAt = pts[69].deviceTs + 1;
    await t.repo.stopRide(d.rideId, { by: 'admin:office', reason: 'End of shift', stoppedAt: stopAt });
    // The phone was offline; it now sends everything it held.
    const late = await upload(t, d, pts.slice(40));
    assert.equal(late.status, 200);
    assert.equal(late.body.data.accepted.length, 30, 'recorded before the stop: kept');
    assert.equal(late.body.data.rejected.length, 30, 'recorded after: refused, and named so the phone drops them');
    assert.equal(late.body.data.rideActive, false);
    const active = await t.call('GET', '/driver/rides/active', null, d.token);
    assert.equal(active.body.data.active, false);
    const rides = await t.repo.listRides({ driverId: d.id });
    assert.equal(rides.length, 1, 'no new ride was started by the late upload');
    assert.equal(rides[0].pointCount, 70);
    const dash = await t.admin('GET', '/admin/dashboard');
    assert.equal(dash.body.data.drivers.find((x) => x.driverId === d.id).tracking.state, 'RIDE_STOPPED');
  } finally { t.close(); }
});

test('J: forty drivers uploading at once each keep their own fixes, position and kilometres', async () => {
  const t = await boot();
  try {
    const drivers = [];
    for (let i = 0; i < 40; i += 1) drivers.push(await driver(t, `Driver ${i}`, 100 + i));
    const t0 = Date.now() - 60 * 4000;
    // Each on their own street, a different length.
    const routes = drivers.map((d, i) => drive({ prefix: `j${i}`, t0, count: 20 + i, lat: LAT + i * 0.01 }));
    await Promise.all(drivers.map((d, i) => upload(t, d, routes[i])));
    await Promise.all(drivers.map((d, i) => upload(t, d, routes[i].slice(5))));   // and a retry each
    for (let i = 0; i < 40; i += 1) {
      const d = drivers[i];
      const ride = await t.repo.getRide(d.rideId);
      assert.equal(ride.pointCount, 20 + i, `driver ${i} point count`);
      const live = (await t.db.collection('driver_live').doc(d.id).get()).data();
      assert.equal(live.rideId, d.rideId);
      assert.ok(Math.abs(live.lat - (LAT + i * 0.01)) < 1e-9, `driver ${i} marker on their own street`);
    }
    const t1 = Date.now();
    const dash = await t.admin('GET', '/admin/dashboard');
    assert.equal(dash.status, 200);
    assert.ok(Date.now() - t1 < 15000, 'the dashboard answers for 40 drivers');
    for (let i = 0; i < 40; i += 1) {
      const p = await t.repo.loadProcessing(drivers[i].rideId, { withSegments: false });
      if (!p) continue;   // the dashboard calculates within a time budget; the rest follow
      const expected = haversineM(routes[i][0], routes[i][routes[i].length - 1]);
      assert.ok(Math.abs(p.distance.metres.measured - expected) < 5, `driver ${i}: ${p.distance.metres.measured} vs ${expected}`);
    }
  } finally { t.close(); }
});

test('a phone clock ten minutes slow, or forty-five fast, no longer loses the day', async () => {
  const t = await boot();
  try {
    const slow = await driver(t, 'Slow Clock', 7);
    const fast = await driver(t, 'Fast Clock', 8);
    // These rides started a minute ago (server time), as on a real morning.
    for (const d of [slow, fast]) await t.db.collection('rides').doc(d.rideId).set({ startedAt: Date.now() - 60000 }, { merge: true });
    const now = Date.now();
    // What each phone believes the time is.
    const slowNow = now - 10 * 60000; const fastNow = now + 45 * 60000;
    const sp = drive({ prefix: 's', t0: slowNow - 10 * 4000, count: 10 });
    const fp = drive({ prefix: 'q', t0: fastNow - 10 * 4000, count: 10 });
    const a = await t.call('POST', `/driver/rides/${slow.rideId}/points`, { points: sp, sentAt: slowNow }, slow.token);
    const b = await t.call('POST', `/driver/rides/${fast.rideId}/points`, { points: fp, sentAt: fastNow }, fast.token);
    // Before: every fix "recorded before this ride started" / "in the future" — and deleted by the phone.
    assert.equal(a.body.data.accepted.length, 10, JSON.stringify(a.body.data.rejected.slice(0, 2)));
    assert.equal(b.body.data.accepted.length, 10, JSON.stringify(b.body.data.rejected.slice(0, 2)));
    const g = (await t.db.collection('rides').doc(slow.rideId).collection('gps_raw').doc(sp[9].clientPointId).get()).data();
    assert.ok(Math.abs(g.deviceTs - (sp[9].deviceTs + 10 * 60000)) < 5000, 'moved onto the server clock');
    assert.equal(g.rawDeviceTs, sp[9].deviceTs, 'the phone\'s own value is kept');
    const dash = await t.admin('GET', '/admin/dashboard');
    for (const d of [slow, fast]) assert.equal(dash.body.data.drivers.find((x) => x.driverId === d.id).tracking.state, 'LIVE');
    // An older app with no sentAt: unchanged behaviour.
    const old = await t.call('POST', `/driver/rides/${slow.rideId}/points`, { points: drive({ prefix: 'o', t0: now - 4000, count: 1 }) }, slow.token);
    assert.equal(old.body.data.clockSkewMs, 0);
  } finally { t.close(); }
});

test('authentication: bad tokens refused with a code, another driver\'s ride refused, drivers kept out of the office API', async () => {
  const t = await boot();
  try {
    const a = await driver(t, 'Owner', 9);
    const b = await driver(t, 'Other', 10);
    const pts = drive({ prefix: 'x', t0: Date.now() - 4000, count: 2 });
    const cross = await upload(t, { ...a, token: b.token }, pts);
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, 'NOT_YOUR_RIDE');
    const missing = await t.call('POST', '/driver/rides/no-such-ride/points', { points: pts }, a.token);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'RIDE_NOT_FOUND');
    const forged = await t.call('POST', `/driver/rides/${a.rideId}/points`, { points: pts }, jwt.sign({ sub: a.id, type: 'driver_access' }, 'wrong-key'));
    assert.equal(forged.status, 401);
    assert.equal(forged.body.code, 'BAD_TOKEN');
    const expired = jwt.sign({ sub: a.id, did: 'dev-9-abcdef', type: 'driver_access', exp: Math.floor(Date.now() / 1000) - 10 }, KEY, { algorithm: 'HS256' });
    assert.equal((await t.call('POST', `/driver/rides/${a.rideId}/points`, { points: pts }, expired)).body.code, 'TOKEN_EXPIRED');
    assert.ok([401, 403].includes((await t.call('GET', '/admin/dashboard', null, a.token)).status), 'a driver token is not an office token');
    const stop = await t.call('POST', `/admin/rides/${a.rideId}/stop`, { reason: 'x y z' }, a.token);
    assert.ok([401, 403].includes(stop.status));
    assert.equal((await t.repo.getRide(a.rideId)).status, 'active', 'and the ride is still running');
    // A deactivated account is refused — and with a code the app does NOT treat as "drop the queue".
    await t.db.collection('drivers').doc(a.id).set({ status: 'inactive' }, { merge: true });
    const off = await upload(t, a, pts);
    assert.equal(off.status, 403);
    assert.equal(off.body.code, 'ACCOUNT_INACTIVE');
  } finally { t.close(); }
});

test('tracking states on the dashboard follow the evidence, and diagnostics separate server from phone', async () => {
  const t = await boot();
  try {
    const d = await driver(t, 'States', 11);
    const row = async () => (await t.admin('GET', '/admin/dashboard')).body.data.drivers.find((x) => x.driverId === d.id);
    assert.equal((await row()).tracking.state, 'UNKNOWN', 'a ride with nothing heard is not LIVE');
    // A fix five minutes old, uploaded now (it was waiting on the phone).
    const old = drive({ prefix: 'st', t0: Date.now() - 5 * 60000, count: 1 });
    await upload(t, d, old, { health: { queuedPoints: 12, oldestQueuedAt: Date.now() - 4 * 60000, locationPermission: 'granted', gpsEnabled: true, watcherRunning: true, lastFixAt: Date.now() - 2000, online: true } });
    assert.equal((await row()).tracking.state, 'SYNC_PENDING');
    // The phone reports its location switch off.
    await t.call('POST', '/driver/health', { gpsEnabled: false, locationPermission: 'device-off', watcherRunning: false, sentAt: Date.now() }, d.token);
    const r = await row();
    assert.equal(r.tracking.state, 'GPS_UNAVAILABLE');
    assert.match(r.tracking.detail, /Location switch is off/);
    assert.ok(r.lastUpdateAt, 'the last known position and its time are still shown');
    const g = await t.admin('GET', `/admin/drivers/${d.id}/diagnostics`);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.data.tracking.state, 'GPS_UNAVAILABLE');
    assert.equal(g.body.data.device.gpsEnabled, false, 'what the phone said');
    assert.equal(g.body.data.server.pointsStored, 1, 'what the server holds');
    assert.ok(g.body.data.explanation.length > 10);
    // Health events are written only when something changes.
    for (let i = 0; i < 3; i += 1) await t.call('POST', '/driver/health', { gpsEnabled: false, locationPermission: 'device-off', watcherRunning: false, sentAt: Date.now() }, d.token);
    const ev = (await t.db.collection('tracking_events').where('rideId', '==', d.rideId).get()).docs.map((x) => x.data()).filter((e) => e.kind === 'health');
    assert.equal(ev.length, 2, 'one for the first report, one for the change — not one per heartbeat');
  } finally { t.close(); }
});
