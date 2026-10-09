// Kilometre audit: a simulated day with a known true distance, run through
// the real pipeline under the faults a phone actually produces. Measured km
// must stay close to the truth, never be inflated by bad fixes, and every
// screen's figure must come from the same metres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { cleanTrack, absorbStopJitter } = require('./src/drivers/track');
const { detectStops } = require('./src/drivers/stops');
const { resolveConfig } = require('./src/drivers/config');
const { buildReplay, calcBefore } = require('./src/services/replay');

const O = { lat: 18.50, lng: 73.86 };
const K = 111320 * Math.cos(O.lat * Math.PI / 180);
const P = (x, y) => ({ lat: O.lat + y / 111320, lng: O.lng + x / K });
const T0 = Date.parse('2026-10-09T08:00:00+05:30');

// Depot → three restaurants → back. City legs: two straight runs with a bend.
function simulate({ speedMps = 7, noiseM = 5, spikes = 0, driftM = 0, seed = 7, jam = null } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const stops = [[0, 0, 900], [1800, 900, 600], [3200, -400, 420], [1500, 2600, 360], [0, 0, 600]];
  const pts = []; let t = T0; let n = 0; let truthM = 0;
  const fix = (x, y, moving) => {
    const p = P(x + gauss() * noiseM, y + gauss() * noiseM);
    pts.push({ clientPointId: `c${n += 1}`, lat: p.lat, lng: p.lng, deviceTs: t, accuracyM: Math.round(noiseM * 1.5) + 3, speedMps: moving ? speedMps : 0 });
  };
  const dwell = ([x, y, sec]) => { for (let i = 0; i < Math.round(sec / 30); i += 1) { t += 30000; fix(x + Math.sin(i / 3) * driftM, y + Math.cos(i / 5) * driftM, false); } };
  dwell(stops[0]);
  for (let k = 1; k < stops.length; k += 1) {
    const [ax, ay] = stops[k - 1]; const [bx, by] = stops[k];
    const road = [];
    for (let i = 0; i <= 40; i += 1) road.push([ax + (bx - ax) * i / 40, ay + Math.sin(i / 40 * Math.PI) * 30]);
    for (let i = 1; i <= 40; i += 1) road.push([bx + Math.sin(i / 40 * Math.PI) * 25, ay + (by - ay) * i / 40]);
    for (let i = 1; i < road.length; i += 1) {
      const L = Math.hypot(road[i][0] - road[i - 1][0], road[i][1] - road[i - 1][1]);
      truthM += L;
    }
    // A fix every 25 m along the road (the app keeps one per 25 m moved).
    let along = 0; let i = 1; let acc = 0;
    while (i < road.length) {
      const [x0, y0] = road[i - 1]; const [x1, y1] = road[i];
      const L = Math.hypot(x1 - x0, y1 - y0);
      if (jam && jam.leg === k && i === 41 && !jam.done) { jam.done = true; for (let j = 0; j < jam.sec / 30; j += 1) { t += 30000; fix(x0, y0, false); } }
      if (acc + L >= along + 25) { const u = (along + 25 - acc) / L; along += 25; t += Math.round(25 / speedMps * 1000); fix(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, true); } else { acc += L; i += 1; }
    }
    dwell(stops[k]);
  }
  const moving = pts.filter((p) => p.speedMps > 0);
  for (let i = 0; i < spikes; i += 1) {
    const p = moving[Math.floor(rnd() * moving.length)];
    const d = 250 + rnd() * 600; const a = rnd() * 2 * Math.PI;
    p.lat += Math.sin(a) * d / 111320; p.lng += Math.cos(a) * d / K; p.accuracyM = 30; p.spike = true;
  }
  return { points: pts, truthM, stops };
}

const place = ([x, y], id) => ({ id, name: id, ...P(x, y), radiusM: 80 });
function processDay(sim, points = sim.points) {
  return processRideData({
    points, ride: { id: 'r', driverId: 'd', startedAt: T0 },
    facilities: [{ ...place(sim.stops[0], 'depot'), radiusM: 120 }],
    restaurants: sim.stops.slice(1, 4).map((s, i) => place(s, `R${i + 1}`)),
    orders: [], declarations: [], reviews: [], nowMs: T0 + 864e5,
  });
}
const errPct = (r, sim) => Math.abs(r.distance.metres.measured - sim.truthM) / sim.truthM * 100;

test('a normal day: measured km within 2% of the true route, buckets reconcile', () => {
  const sim = simulate();
  const r = processDay(sim);
  assert.ok(errPct(r, sim) < 2, `${r.distance.metres.measured} vs ${Math.round(sim.truthM)}`);
  assert.equal(r.distance.reconciliation.ok, true);
  const m = r.distance.metres;
  assert.equal(m.verifiedBusiness + m.likelyBusiness + m.personal + m.unknown + m.invalid + m.gapEstimate, m.dayTotal);
});

test('GPS spikes in slow traffic add no kilometres (were +65%)', () => {
  const sim = simulate({ speedMps: 1, spikes: 10 });
  const r = processDay(sim);
  assert.ok(errPct(r, sim) < 2, `${r.distance.metres.measured} vs ${Math.round(sim.truthM)}`);
  assert.equal(r.track.totals.byReason.outlier_spike, 10);
  assert.equal(r.track.totals.rawCount, sim.points.length, 'nothing deleted');
  assert.equal(r.distance.reconciliation.ok, true);
});

test('a spike does not drag the real fixes after it out of the count', () => {
  const cfg = resolveConfig({}).config;
  const pts = [];
  for (let i = 0; i < 10; i += 1) pts.push({ clientPointId: `p${i}`, ...P(i * 30, 0), deviceTs: T0 + i * 30000, accuracyM: 8 });
  Object.assign(pts[4], P(4 * 30, 600));   // one fix 600 m off, 30 s after the last
  const t = cleanTrack(pts, cfg, T0 + 864e5);
  assert.deepEqual(t.points.filter((p) => !p.countDistance).map((p) => p.clientPointId), ['p4']);
  assert.equal(t.points[4].quality, 'outlier_spike');
  assert.ok(Math.abs(t.totals.measuredM - 270) < 1, String(t.totals.measuredM));
});

test('a two-fix spike is caught too', () => {
  const cfg = resolveConfig({}).config;
  const pts = [];
  for (let i = 0; i < 10; i += 1) pts.push({ clientPointId: `p${i}`, ...P(i * 30, 0), deviceTs: T0 + i * 30000, accuracyM: 8 });
  Object.assign(pts[4], P(4 * 30, 500)); Object.assign(pts[5], P(5 * 30, 520));
  const t = cleanTrack(pts, cfg, T0 + 864e5);
  assert.deepEqual(t.points.filter((p) => p.quality === 'outlier_spike').map((p) => p.clientPointId), ['p4', 'p5']);
});

test('real driving is never taken for a spike: sparse corners, a U-turn after several fixes, a tracking gap', () => {
  const cfg = resolveConfig({}).config;
  const mk = (xy, dt = 30000) => xy.map(([x, y], i) => ({ clientPointId: `q${i}`, ...P(x, y), deviceTs: T0 + i * dt, accuracyM: 8 }));
  // Round a corner with fixes 150 m apart.
  assert.equal(cleanTrack(mk([[0, 0], [150, 0], [150, 150], [300, 150]]), cfg, T0 + 864e5).totals.byReason.outlier_spike, undefined);
  // Drive 400 m out and back, fixes every 100 m.
  assert.equal(cleanTrack(mk([[0, 0], [100, 0], [200, 0], [300, 0], [400, 0], [300, 0], [200, 0], [100, 0], [0, 0]]), cfg, T0 + 864e5).totals.byReason.outlier_spike, undefined);
  // Out and back across tracking gaps is a gap, not a spike.
  assert.equal(cleanTrack(mk([[0, 0], [2000, 0], [0, 0]], 400000), cfg, T0 + 864e5).totals.byReason.outlier_spike, undefined);
});

test('indoor drift that splits one parked stop adds no drive between the halves; both stops kept', () => {
  const cfg = resolveConfig({}).config;
  const pts = []; let t = T0; let n = 0;
  const at = (x, y) => { pts.push({ clientPointId: `d${n += 1}`, ...P(x, y), deviceTs: t, accuracyM: 20 }); t += 30000; };
  for (let i = 0; i < 8; i += 1) at(0, 0);       // 4 min parked
  at(70, 20); at(90, 30);                          // phone wanders 90 m
  for (let i = 0; i < 8; i += 1) at(40, 50);      // settles 64 m from the first spot
  const t1 = cleanTrack(pts, cfg, T0 + 864e5);
  const stops = detectStops(t1.points, cfg);
  assert.equal(stops.length, 2, 'two stops — could be two neighbouring restaurants');
  const totals = absorbStopJitter(t1, stops, cfg);
  assert.equal(Math.round(totals.measuredM), 0);
  // A real drive away between two visits to one place still counts.
  const pts2 = []; t = T0; n = 0;
  const at2 = (x, y) => { pts2.push({ clientPointId: `e${n += 1}`, ...P(x, y), deviceTs: t, accuracyM: 8 }); t += 30000; };
  for (let i = 0; i < 6; i += 1) at2(0, 0);
  for (const x of [100, 200, 300, 200, 100]) at2(x, 0);
  for (let i = 0; i < 6; i += 1) at2(0, 0);
  const t2 = cleanTrack(pts2, cfg, T0 + 864e5);
  assert.ok(absorbStopJitter(t2, detectStops(t2.points, cfg), cfg).measuredM > 550);
});

test('one dwell split by a short wander is one stop', () => {
  const cfg = resolveConfig({}).config;
  const pts = []; let t = T0; let n = 0;
  const at = (x, y) => { pts.push({ clientPointId: `m${n += 1}`, ...P(x, y), deviceTs: t, accuracyM: 20 }); t += 30000; };
  for (let i = 0; i < 6; i += 1) at(0, 0);
  at(80, 0);
  for (let i = 0; i < 6; i += 1) at(10, 5);
  const stops = detectStops(cleanTrack(pts, cfg, T0 + 864e5).points, cfg);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].dwellSec, 12 * 30);
});

test('upload order, retries and duplicates do not change the kilometres', () => {
  const sim = simulate();
  const a = processDay(sim);
  const shuffled = [...sim.points, ...sim.points.slice(40, 140)];
  for (let i = shuffled.length - 1; i > 0; i -= 1) { const k = (i * 7919) % (i + 1); [shuffled[i], shuffled[k]] = [shuffled[k], shuffled[i]]; }
  const b = processDay(sim, shuffled);
  assert.deepEqual(b.distance.metres, a.distance.metres);
  assert.equal(b.track.totals.byReason.duplicate, 100);
});

test('the replay ends at exactly the measured total; old results replay by their own rules', () => {
  const sim = simulate({ speedMps: 1, spikes: 6 });
  const r = processDay(sim);
  const rep = buildReplay(sim.points, { ...r, processedAt: T0 + 864e5 });
  assert.equal(rep.points[rep.points.length - 1].d, r.distance.metres.measured);
  assert.equal(rep.points.filter((p) => p.q === 'outlier_spike').length, 6);
  const old = buildReplay(sim.points, { ...r, calcVersion: '1.5.0', processedAt: T0 + 864e5 });
  assert.equal(old.points.filter((p) => p.q === 'outlier_spike').length, 0);
  assert.equal(calcBefore('1.5.0', '1.6.0'), true);
  assert.equal(calcBefore('1.6.0', '1.6.0'), false);
  assert.equal(calcBefore('1.10.0', '1.6.0'), false);
  assert.equal(calcBefore(undefined, '1.6.0'), true);
});

test('every screen reads the same metres: fleet totals are summed before rounding', () => {
  const admin = fs.readFileSync(path.join(ROOT, 'backend/src/routes/admin.js'), 'utf8');
  assert.match(admin, /const fleetKm = \(k\) => Math\.round\(rows\.reduce\(\(s, r\) => s \+ \(r\.metres\[k\] \|\| 0\), 0\) \/ 100\) \/ 10;/);
  assert.doesNotMatch(admin, /r\.today\.totalKm \|\| 0/);
  assert.match(admin, /for \(const r of rows\) delete r\.metres;/);
  const hist = fs.readFileSync(path.join(ROOT, 'backend/src/services/history.js'), 'utf8');
  assert.match(hist, /const m = result\.distance\.metres;/);
});

test('a two-minute jam on a grid route home keeps the trip business (was ~4 km unknown)', () => {
  const normal = processDay(simulate());
  // Stuck 2½ minutes at the corner of the grid route from the last restaurant
  // to the depot: 1.37 × the straight line there.
  const jam = processDay(simulate({ jam: { leg: 4, sec: 150 } }));
  const biz = (r) => r.distance.metres.verifiedBusiness + r.distance.metres.likelyBusiness;
  assert.ok(Math.abs(biz(jam) - biz(normal)) / biz(normal) < 0.02, `${biz(jam)} vs ${biz(normal)}`);
  const pause = jam.segments.find((s) => (s.evidence || []).some((e) => e.code === 'transit_stop'));
  assert.ok(pause, 'the jam is a pause on the way');
  assert.equal(pause.type, 'RETURN_TO_MODERN_DAIRY');
});
