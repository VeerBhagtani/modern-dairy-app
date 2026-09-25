// Phase 2: routes and kilometres, checked against routes whose true length is
// known because they were built by hand.
//
// Every track here is synthetic TEST data, generated in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { haversineM } = require('./src/drivers/geo');
const { readAll } = require('./src/services/paging');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── building tracks ───────────────────────────────────────────────────────
const T0 = Date.parse('2026-09-15T03:30:00Z');          // 09:00 IST
const ORIGIN = { lat: 18.5018, lng: 73.8636 };           // Market Yard depot
const at = (north, east) => ({
  lat: ORIGIN.lat + north / 111320,
  lng: ORIGIN.lng + east / (111320 * Math.cos(ORIGIN.lat * Math.PI / 180)),
});
const DEPOT = { id: 'depot', name: 'Modern Dairy depot', ...at(0, 0), radiusM: 150 };
const A = { id: 'A', name: 'Restaurant A', customerId: 'CA', ...at(3000, 0), radiusM: 80 };
const B = { id: 'B', name: 'Restaurant B', customerId: 'CB', ...at(3000, 4000), radiusM: 80 };
const C = { id: 'C', name: 'Restaurant C', customerId: 'CC', ...at(0, 4000), radiusM: 80 };

// Deterministic noise.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* A route through waypoints: { to, dwellSec } — drives in straight lines at
 * speedMps, sampling every intervalSec, and waits dwellSec at each waypoint. */
function route(start, legs, { intervalSec = 10, speedMps = 8, noiseM = 0, seed = 1, t0 = T0, prefix = 'dev' } = {}) {
  const r = rng(seed);
  const jitter = () => (noiseM ? (r() - 0.5) * 2 * noiseM : 0);
  const pts = [];
  let ts = t0; let seq = 0; let cur = { lat: start.lat, lng: start.lng };
  const push = (p) => {
    const n = jitter(); const e = jitter();
    pts.push({ clientPointId: `${prefix}:${String(seq++).padStart(7, '0')}`, lat: p.lat + n / 111320,
      lng: p.lng + e / (111320 * Math.cos(p.lat * Math.PI / 180)), deviceTs: ts, accuracyM: 8 });
  };
  push(cur);
  for (const leg of legs) {
    if (leg.dwellSec) { for (let w = intervalSec; w <= leg.dwellSec; w += intervalSec) { ts += intervalSec * 1000; push(cur); } }
    if (!leg.to) continue;
    const d = haversineM(cur, leg.to);
    const steps = Math.max(1, Math.ceil(d / (speedMps * intervalSec)));
    const from = cur;
    for (let i = 1; i <= steps; i += 1) {
      ts += intervalSec * 1000;
      push({ lat: from.lat + (leg.to.lat - from.lat) * (i / steps), lng: from.lng + (leg.to.lng - from.lng) * (i / steps) });
    }
    cur = { lat: leg.to.lat, lng: leg.to.lng };
    if (leg.waitAfter) { for (let w = intervalSec; w <= leg.waitAfter; w += intervalSec) { ts += intervalSec * 1000; push(cur); } }
  }
  return pts;
}
const run = (points, extra = {}) => processRideData({
  points: points.map((p) => ({ ...p })),
  ride: { id: 'ride-t', driverId: 'drv-t', startedAt: points[0] ? points[0].deviceTs : T0 },
  facilities: [DEPOT], restaurants: [A, B, C, ...(extra.moreRestaurants || [])],
  orders: [], declarations: [], reviews: [], nowMs: T0 + 48 * 3600e3, ...extra,
});
const near = (actual, expected, tolFrac, msg) => assert.ok(Math.abs(actual - expected) <= expected * tolFrac,
  `${msg}: ${actual} vs ${expected} (±${(tolFrac * 100).toFixed(1)}%)`);

// The day in the brief: Depot → A → B → C → Depot, a 5-minute stop at each.
const DAY = route(DEPOT, [{ dwellSec: 300 }, { to: A, waitAfter: 300 }, { to: B, waitAfter: 300 }, { to: C, waitAfter: 300 }, { to: DEPOT, waitAfter: 300 }]);
const DAY_RESULT = run(DAY);

// ── distance is the sum of the hops, not start → end ──────────────────────
test('A→B→C→D: the measured distance is the sum of the legs, not the straight line', () => {
  const pts = route(at(0, 0), [{ to: at(1000, 0) }, { to: at(1000, 2000) }, { to: at(-500, 2000) }]);
  const r = run(pts, { facilities: [] });
  near(r.distance.metres.measured, 1000 + 2000 + 1500, 0.005, 'measured');
  const straight = haversineM(pts[0], pts[pts.length - 1]);
  assert.ok(r.distance.metres.measured > straight * 1.5, 'far longer than first → last');
});

test('the total is exactly the sum of distances between consecutive counted fixes', () => {
  const r = run(DAY);
  // Recompute independently: consecutive accepted points, hops under the
  // jitter threshold not counted, as the config says.
  const minMove = r.configUsed.minMoveM;
  const sorted = [...DAY].sort((a, b) => a.deviceTs - b.deviceTs);
  let sum = 0;
  for (let i = 1; i < sorted.length; i += 1) { const d = haversineM(sorted[i - 1], sorted[i]); if (d >= minMove) sum += d; }
  assert.ok(Math.abs(r.distance.metres.measured - sum) <= 1, `${r.distance.metres.measured} vs ${sum}`);
});

test('the order points arrive in does not matter: offline batches uploaded later give the same result', () => {
  const shuffled = [...DAY];
  const r = rng(7);
  for (let i = shuffled.length - 1; i > 0; i -= 1) { const j = Math.floor(r() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  // Two thirds sent live, the last third held offline and sent at the end.
  const cut = Math.floor(DAY.length * 0.66);
  const late = [...DAY.slice(0, cut), ...DAY.slice(cut).reverse()];
  const base = JSON.stringify(DAY_RESULT.distance.metres);
  assert.equal(JSON.stringify(run(shuffled).distance.metres), base);
  assert.equal(JSON.stringify(run(late).distance.metres), base);
});

// ── stops, visits, legs ───────────────────────────────────────────────────
test('the day is understood as Depot → A → B → C → Depot, with each leg measured', () => {
  const r = DAY_RESULT;
  const visits = r.visits.map((v) => v.placeId);
  assert.deepEqual(visits, ['A', 'B', 'C']);
  const legs = r.legs.map((l) => `${l.from.name} → ${l.to.name}`);
  assert.deepEqual(legs, [
    'Modern Dairy depot → Restaurant A',
    'Restaurant A → Restaurant B',
    'Restaurant B → Restaurant C',
    'Restaurant C → Modern Dairy depot',
  ]);
  const expect = [3000, 4000, 3000, 4000];
  r.legs.forEach((l, i) => near(l.measuredM, expect[i], 0.06, `leg ${legs[i]}`));
  // Every leg is business; nothing personal or unknown in this day.
  for (const l of r.legs) assert.ok(['verifiedBusiness', 'likelyBusiness'].includes(l.mainly), `${l.from.name}: ${l.mainly}`);
  assert.equal(r.distance.metres.personal, 0);
  assert.equal(r.distance.metres.unknown, 0);
  // Legs + what was measured while stopped = the ride's measured total.
  assert.ok(Math.abs(r.legsCheck.residualM) < 1, JSON.stringify(r.legsCheck));
});

test('a stationary driver adds (almost) nothing, however long the phone jitters', () => {
  const still = route(at(5000, 5000), [{ dwellSec: 1800 }], { noiseM: 8, seed: 3 });
  const r = run(still);
  assert.ok(r.distance.metres.measured < 60, `measured ${r.distance.metres.measured} m while parked`);
  assert.equal(r.counts.stops, 1);
});

test('GPS jitter while driving: the distance stays within a few percent of the truth', () => {
  const pts = route(DEPOT, [{ to: A }, { to: B }], { noiseM: 6, seed: 11 });
  near(run(pts).distance.metres.measured, 7000, 0.04, 'with 6 m jitter');
});

test('a stop needs the configured time inside the geofence: a drive-by or a 1-minute halt is not a visit', () => {
  // Drives straight past A without stopping.
  const past = route(at(1500, 0), [{ to: at(4500, 0) }]);
  assert.equal(run(past).visits.length, 0, 'drive-by');
  // One minute at A.
  const brief = route(at(1500, 0), [{ to: A, waitAfter: 60 }, { to: at(4500, 0) }]);
  assert.equal(run(brief).visits.length, 0, '60 s halt');
  // Two and a half minutes at A: a visit.
  const real = route(at(1500, 0), [{ to: A, waitAfter: 150 }, { to: at(4500, 0) }]);
  const r = run(real);
  assert.deepEqual(r.visits.map((v) => v.placeId), ['A']);
  assert.ok(r.visits[0].dwellSec >= 120);
});

test('a single GPS point inside a geofence never creates a visit', () => {
  const pts = route(at(1500, 0), [{ to: at(4500, 0) }], { intervalSec: 30 });
  const r = run(pts);
  assert.equal(r.visits.length, 0);
  assert.equal(r.segments.filter((s) => s.type === 'LIKELY_RESTAURANT_VISIT').length, 0);
});

test('overlapping geofences: the system refuses to pick, and the legs wait for a person', () => {
  const A2 = { id: 'A2', name: 'Restaurant A2 (next door)', customerId: 'CA2', ...at(3040, 0), radiusM: 80 };
  const r = run(route(DEPOT, [{ dwellSec: 300 }, { to: A, waitAfter: 300 }, { to: DEPOT, waitAfter: 300 }]), { moreRestaurants: [A2] });
  const visit = r.segments.find((s) => s.type === 'LIKELY_RESTAURANT_VISIT');
  assert.equal(visit.confidence, 'LOW');
  assert.ok(visit.needsReview);
  assert.equal(visit.ambiguousPlaces.length, 2);
  assert.ok(r.distance.metres.unknown > 5000, 'both legs unknown, not business');
});

// ── the day's awkward moments ─────────────────────────────────────────────
test('a pause in traffic on the way to a restaurant does not turn the trip personal', () => {
  // Three minutes stuck halfway to A, on the road.
  const pts = route(DEPOT, [{ dwellSec: 300 }, { to: at(1500, 0), waitAfter: 180 }, { to: A, waitAfter: 300 }, { to: DEPOT, waitAfter: 300 }]);
  const r = run(pts);
  assert.equal(r.distance.metres.personal, 0, 'nothing personal');
  const leg = r.legs[0];
  assert.equal(`${leg.from.name} → ${leg.to.name}`, 'Modern Dairy depot → Restaurant A', 'one leg, not two');
  near(leg.measuredM, 3000, 0.06, 'depot → A');
  const pause = r.segments.find((s) => s.transit);
  assert.ok(pause, 'the pause is recognised');
  assert.match(pause.evidence.map((e) => e.code).join(), /transit_stop/);
});

test('a detour to a non-customer on the way back is personal, not business', () => {
  // A → a Porter drop 2 km off to the side → depot.
  const porter = at(3000, -2000);
  const pts = route(DEPOT, [{ dwellSec: 300 }, { to: A, waitAfter: 300 }, { to: porter, waitAfter: 300 }, { to: DEPOT, waitAfter: 300 }]);
  const r = run(pts);
  assert.ok(r.distance.metres.personal > 3000, `personal ${r.distance.metres.personal}`);
  assert.ok(!r.segments.some((s) => s.transit), 'a detour is not a pause on the way');
});

test('missing points: a GPS gap is estimated separately and never counted as measured or business', () => {
  const before = route(DEPOT, [{ dwellSec: 300 }, { to: at(1000, 0) }]);
  const last = before[before.length - 1];
  const after = route(at(2500, 0), [{ to: A, waitAfter: 300 }], { t0: last.deviceTs + 15 * 60e3, prefix: 'dev2' });
  const r = run([...before, ...after]);
  assert.equal(r.track.gaps.length, 1);
  near(r.distance.metres.gapEstimate, 1500, 0.02, 'straight-line estimate across the gap');
  near(r.distance.metres.measured, 1000 + 500, 0.06, 'measured excludes the gap');
  assert.ok(r.segments.some((s) => (s.evidence || []).some((e) => e.code === 'partial_tracking_gap' || e.code === 'tracking_gap')));
});

test('duplicate points (an upload sent twice) change nothing and are named', () => {
  const doubled = [...DAY, ...DAY.map((p) => ({ ...p }))];
  const r = run(doubled);
  assert.equal(JSON.stringify(r.distance.metres), JSON.stringify(DAY_RESULT.distance.metres));
  assert.equal(r.track.totals.byReason.duplicate, DAY.length);
});

test('a GPS jump (one fix kilometres away) is excluded with its reason; the route is untouched', () => {
  const spiked = DAY.map((p) => ({ ...p }));
  const i = 80;
  spiked[i] = { ...spiked[i], lat: spiked[i].lat + 0.05 };   // ~5.5 km off for one fix
  const r = run(spiked);
  const bad = r.track.excludedPoints.find((x) => x.clientPointId === spiked[i].clientPointId);
  assert.equal(bad.quality, 'implausible_jump');
  assert.ok(Math.abs(r.distance.metres.measured - DAY_RESULT.distance.metres.measured) < 150, 'one missing fix, not 11 km of spike');
});

test('stale, future-dated and inaccurate fixes are excluded, each with its reason', () => {
  const pts = DAY.map((p) => ({ ...p }));
  pts[10] = { ...pts[10], accuracyM: 900 };
  pts[20] = { ...pts[20], deviceTs: T0 + 50 * 3600e3 };        // beyond the clock-skew allowance
  pts[30] = { ...pts[30], accuracyM: 120 };                      // poor but usable: counted, flagged
  const r = run(pts);
  const why = Object.fromEntries(r.track.excludedPoints.map((x) => [x.clientPointId, x.quality]));
  assert.equal(why[pts[10].clientPointId], 'bad_accuracy');
  assert.equal(why[pts[20].clientPointId], 'bad_timestamp');
  assert.equal(why[pts[30].clientPointId], undefined);
  assert.equal(r.track.totals.byReason.low_accuracy, 1);
  // Every excluded fix carries a reason.
  for (const x of r.track.excludedPoints) assert.ok(x.quality && x.quality !== 'ok');
});

// ── buckets reconcile, always ─────────────────────────────────────────────
test('verified + likely + personal + unknown (+ invalid) = measured, exactly, in metres and km, over 60 random days', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const r2 = rng(seed);
    const pick = () => [A, B, C, at(r2() * 6000 - 1000, r2() * 6000 - 1000)][Math.floor(r2() * 4)];
    const legs = [{ dwellSec: 200 }];
    for (let k = 0; k < 5; k += 1) legs.push({ to: pick(), waitAfter: Math.floor(r2() * 500) });
    legs.push({ to: DEPOT, waitAfter: 200 });
    const res = run(route(DEPOT, legs, { noiseM: r2() * 10, seed }));
    const m = res.distance.metres; const km = res.distance.km;
    assert.equal(m.verifiedBusiness + m.likelyBusiness + m.personal + m.unknown + m.invalid, m.measured, `metres, seed ${seed}`);
    assert.equal(Math.round((km.verifiedBusiness + km.likelyBusiness + km.personal + km.unknown + km.invalid) * 10), Math.round(km.measured * 10), `km, seed ${seed}`);
    assert.ok(res.distance.reconciliation.ok, `residual, seed ${seed}: ${JSON.stringify(res.distance.reconciliation)}`);
    assert.ok(Math.abs(res.legsCheck.residualM) < 1, `legs, seed ${seed}`);
  }
});

test('the km shown add up to the total shown (no rounding drift)', () => {
  const { summariseDistance } = require('./src/drivers/distance');
  const segs = ['BUSINESS_TRAVEL', 'PERSONAL_OR_NON_BUSINESS', 'UNKNOWN'].map((type, i) => ({ id: `s${i}`, type, confidence: 'MEDIUM', distanceM: 3040, gapEstimateM: 0 }));
  const d = summariseDistance(segs, { measuredM: 9120, totalM: 9120 });
  assert.equal(d.km.measured, 9.1);
  assert.equal(Math.round((d.km.likelyBusiness + d.km.personal + d.km.unknown) * 10), 91);
});

// ── long rides, and no truncation anywhere ─────────────────────────────────
test('a very long ride: 16 hours at a fix every 5 s is processed whole', () => {
  const legs = [{ dwellSec: 300 }];
  for (let k = 0; k < 40; k += 1) legs.push({ to: [A, B, C, DEPOT][k % 4], waitAfter: 300 });
  const pts = route(DEPOT, legs, { intervalSec: 5, speedMps: 2.5 });
  assert.ok(pts.length > 11000, `${pts.length} points`);
  const t = Date.now();
  const r = run(pts);
  assert.equal(r.counts.points, pts.length, 'every point read');
  assert.ok(r.distance.reconciliation.ok);
  assert.ok(Date.now() - t < 20000, 'in reasonable time');
  assert.equal(r.visits.length, 30, 'every restaurant visit found');
});

test('reading a ride\'s points pages through all of them — no cap', async () => {
  const docs = Array.from({ length: 12345 }, (_, i) => ({ data: () => ({ i }) }));
  const pages = [];
  const makeQuery = (after) => ({
    get: async () => {
      const start = after ? docs.indexOf(after) + 1 : 0;
      pages.push(start);
      const slice = docs.slice(start, start + 5000);
      return { docs: slice, size: slice.length };
    },
  });
  const out = await readAll(makeQuery, 5000);
  assert.equal(out.length, 12345);
  assert.deepEqual(pages, [0, 5000, 10000]);
  assert.match(read('backend/src/services/repo.js'), /return readAll\(\(after\) => \{/);
  assert.doesNotMatch(read('backend/src/services/repo.js'), /loadPoints\(rideId, \{ limit/);
});

// ── reprocessing ──────────────────────────────────────────────────────────
test('processing the same ride twice gives the same answer (deterministic)', () => {
  const again = run(DAY);
  assert.equal(JSON.stringify(again.segments), JSON.stringify(DAY_RESULT.segments));
  assert.equal(JSON.stringify(again.legs), JSON.stringify(DAY_RESULT.legs));
});

test('a recalculation leaves no ghost segments or matches behind', () => {
  const repo = read('backend/src/services/repo.js');
  const save = repo.slice(repo.indexOf('async function saveProcessing'), repo.indexOf('async function loadProcessing'));
  assert.match(save, /for \(const d of oldSegs\.docs\) if \(!segIds\.has\(d\.id\)\) writer\.delete\(d\.ref\);/);
  assert.match(save, /for \(const d of oldMatches\.docs\) if \(!keep\.has\(d\.id\)\) mWriter\.delete\(d\.ref\);/);
});

test('an upload sent twice is stored once and counted once', () => {
  const repo = read('backend/src/services/repo.js');
  const ingest = repo.slice(repo.indexOf('async function ingestPoints'), repo.indexOf('// Every point of the ride'));
  assert.match(ingest, /writer\.create\(C\.gps\(rideId\)\.doc\(p\.clientPointId\)/, 'create, keyed by the phone\'s point id');
  assert.match(ingest, /pointCount: \(doc\.data\(\)\.pointCount \|\| 0\) \+ written/, 'only new points counted');
});

test('the calculation version bump recalculates recent rides', () => {
  const { needsCalc } = require('./src/services/freshness');
  const { CALC_VERSION } = require('./src/drivers/config');
  const now = Date.now();
  const base = { pointCount: 10, processedAt: now - 1000, processedInputsAt: now - 1000, lastUploadAt: now - 2000, status: 'stopped', startedAt: now - 864e5 };
  assert.equal(needsCalc({ ...base, calcVersion: CALC_VERSION }, now), false);
  assert.equal(needsCalc({ ...base, calcVersion: '1.0.0' }, now), true);
  assert.equal(needsCalc({ ...base, calcVersion: '1.0.0', startedAt: now - 90 * 864e5 }, now), false, 'old rides keep their stamped result');
});

test('geofence: stopping nearby but outside the radius is not a visit', () => {
  // Five minutes parked 150 m from A (radius 80 m).
  const pts = route(at(1500, 0), [{ to: at(3150, 0), waitAfter: 300 }, { to: at(4500, 0) }]);
  const r = run(pts);
  assert.equal(r.visits.length, 0);
  const stop = r.segments.find((s) => s.kind === 'stop');
  assert.ok(stop.needsReview, 'flagged: a customer is close by');
});

test('geofence: GPS less accurate than the geofence cannot prove a visit', () => {
  const pts = route(DEPOT, [{ dwellSec: 300 }, { to: A, waitAfter: 300 }, { to: DEPOT, waitAfter: 300 }])
    .map((p) => (haversineM(p, A) < 100 ? { ...p, accuracyM: 150 } : p));
  const r = run(pts);
  const visit = r.segments.find((s) => s.type === 'LIKELY_RESTAURANT_VISIT');
  assert.equal(visit.confidence, 'LOW');
  assert.ok(visit.evidence.some((e) => e.code === 'poor_gps_for_geofence'));
  assert.equal(r.distance.metres.verifiedBusiness + r.distance.metres.likelyBusiness, 0, 'no business on unproven evidence');
});
