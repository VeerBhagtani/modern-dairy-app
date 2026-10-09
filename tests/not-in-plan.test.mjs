// Only a restaurant on the day's round can be a missed delivery. A trial
// round: four planned restaurants, and on the way the driver slowed beside
// three others. Those three are "passed, not in plan" — listed apart, never
// missed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { buildReplay } = require('./src/services/replay');
const { buildJourney } = require('./src/drivers/journey');
const { haversineM } = require('./src/drivers/geo');

const T0 = Date.parse('2026-10-09T03:00:00Z');
const M = (dx, dy) => ({ lat: 18.50 + dy / 111320, lng: 73.86 + dx / (111320 * Math.cos(18.5 * Math.PI / 180)) });
const DEPOT = { id: 'depot', name: 'Modern Dairy', ...M(0, 0), radiusM: 150 };
const R = (id, x, y) => ({ id, name: `Restaurant ${id}`, customerId: `C${id}`, ...M(x, y), radiusM: 80 });
const P1 = R('P1', 1500, 0); const P2 = R('P2', 3000, 0); const P3 = R('P3', 3000, 1500); const P4 = R('P4', 1500, 1500);
const X1 = R('X1', 700, 0); const X2 = R('X2', 2300, 0); const X3 = R('X3', 3000, 800); const X4 = R('X4', 800, 1500);
const ALL = [P1, P2, P3, P4, X1, X2, X3, X4];

function day(stops) {
  const pts = []; let t = T0; let n = 0; let here = stops[0].at;
  const fix = (p, sp) => { pts.push({ clientPointId: `p${n += 1}`, lat: p.lat, lng: p.lng, deviceTs: t, accuracyM: 8, speedMps: sp }); t += 10000; };
  for (const s of stops) {
    const steps = Math.max(1, Math.round(haversineM(here, s.at) / 80));
    for (let k = 1; k <= steps; k += 1) fix({ lat: here.lat + (s.at.lat - here.lat) * k / steps, lng: here.lng + (s.at.lng - here.lng) * k / steps }, 8);
    for (let k = 0; k < s.dwellSec / 10; k += 1) fix(s.at, 0);
    here = s.at;
  }
  return pts;
}
const planOf = (ids) => ids.map((placeId) => ({ placeId, plannedAt: T0 - 60000 }));
const ride = (plan) => ({ id: 'r', driverId: 'd', startedAt: T0, status: 'completed', plannedStops: plan });
function run(points, plan, overrides) {
  const r = processRideData({ points, ride: ride(plan), facilities: [DEPOT], restaurants: ALL, orders: [], declarations: [], reviews: [], configOverrides: overrides, nowMs: T0 + 864e5 });
  const proc = { ...r, processedAt: T0 + 864e5 };
  const j = buildJourney({ ride: ride(plan), processing: proc, replay: buildReplay(points, proc), places: { facilities: [DEPOT], restaurants: ALL } });
  return { r, j };
}

// Depot → P1 → P2 → P3 → P4 → depot; brief halts beside X1, X2, X3 on the way.
const TRIAL = [{ at: DEPOT, dwellSec: 300 }, { at: X1, dwellSec: 40 }, { at: P1, dwellSec: 300 }, { at: X2, dwellSec: 60 }, { at: P2, dwellSec: 300 },
  { at: X3, dwellSec: 30 }, { at: P3, dwellSec: 300 }, { at: P4, dwellSec: 300 }, { at: DEPOT, dwellSec: 300 }];

test('restaurants passed on the way are not missed deliveries; they are listed apart', () => {
  const { r, j } = run(day(TRIAL), planOf(['P1', 'P2', 'P3', 'P4']));
  assert.deepEqual(r.shortVisits, [], 'nothing missed');
  assert.deepEqual(r.passedBy.map((v) => v.placeId), ['X1', 'X2', 'X3']);
  assert.equal(r.matching.unmatchedOrders.length, 0, 'all four planned restaurants delivered');
  assert.equal(j.totals.missedDeliveries, 0);
  assert.ok(!j.events.some((e) => e.kind === 'missed'));
  assert.deepEqual(j.events.filter((e) => e.kind === 'passed').map((e) => e.label), ['Restaurant X1', 'Restaurant X2', 'Restaurant X3']);
  assert.deepEqual(j.notInPlan.map((x) => [x.placeName, x.kind]), [['Restaurant X1', 'passed'], ['Restaurant X2', 'passed'], ['Restaurant X3', 'passed']]);
  assert.equal(j.totals.notInPlan, 3);
});

test('a short halt at a planned restaurant is still a missed delivery', () => {
  const trip = TRIAL.map((s) => (s.at === P3 ? { at: P3, dwellSec: 50 } : s));
  const { r, j } = run(day(trip), planOf(['P1', 'P2', 'P3', 'P4']));
  assert.deepEqual(r.shortVisits.map((v) => v.placeId), ['P3']);
  assert.equal(r.matching.unmatchedOrders.find((o) => o.placeId === 'P3').missedReason, 'too_short');
  assert.equal(j.totals.missedDeliveries, 1);
  assert.ok(!r.passedBy.some((v) => v.placeId === 'P3'));
});

test('an office order for this driver makes a place expected too; another driver\'s does not', () => {
  const pts = day([{ at: DEPOT, dwellSec: 300 }, { at: X2, dwellSec: 50 }, { at: P2, dwellSec: 300 }, { at: DEPOT, dwellSec: 300 }]);
  const order = (driver) => ({ id: 'o1', customerId: 'CX2', assignedDriverId: driver, windowStart: T0, windowEnd: T0 + 8 * 3600e3 });
  const mine = processRideData({ points: pts, ride: ride([]), facilities: [DEPOT], restaurants: ALL, orders: [order('d')], declarations: [], reviews: [], nowMs: T0 + 864e5 });
  assert.deepEqual(mine.shortVisits.map((v) => v.placeId), ['X2']);
  const theirs = processRideData({ points: pts, ride: ride([]), facilities: [DEPOT], restaurants: ALL, orders: [order('other')], declarations: [], reviews: [], nowMs: T0 + 864e5 });
  assert.deepEqual(theirs.shortVisits, []);
  assert.deepEqual(theirs.passedBy.map((v) => v.placeId), ['X2']);
});

test('no plan and no orders: nothing can be missed', () => {
  const { r, j } = run(day(TRIAL), []);
  assert.deepEqual(r.shortVisits, []);
  assert.equal(j.totals.missedDeliveries, 0);
  assert.equal(r.passedBy.length, 3);
});

test('a short stop beside an unplanned restaurant is a pause, not a missed delivery (stops shorter than 2 min)', () => {
  const trip = [{ at: DEPOT, dwellSec: 300 }, { at: X2, dwellSec: 80 }, { at: P2, dwellSec: 300 }, { at: DEPOT, dwellSec: 300 }];
  const { r, j } = run(day(trip), planOf(['P2']), { stopMinDwellSec: 60 });
  const seg = r.segments.find((s) => s.passedBy && s.passedBy.id === 'X2');
  assert.ok(seg, 'the stop is marked as passing X2');
  assert.equal(seg.missedDelivery, false);
  assert.ok(!r.segments.some((s) => s.missedDelivery));
  assert.equal(j.totals.missedDeliveries, 0);
  assert.ok(j.notInPlan.some((x) => x.placeName === 'Restaurant X2'));
  assert.match(j.stops.find((s) => s.passedBy).label, /Paused by Restaurant X2 \(not in plan\)/);
  // The trip to P2 is still business through the pause.
  assert.equal(r.distance.metres.unknown < 200, true, `unknown ${r.distance.metres.unknown}`);
});

test('a real visit to an unplanned restaurant stays a visit, flagged as extra', () => {
  const trip = [{ at: DEPOT, dwellSec: 300 }, { at: X2, dwellSec: 300 }, { at: P2, dwellSec: 300 }, { at: DEPOT, dwellSec: 300 }];
  const { r, j } = run(day(trip), planOf(['P2']));
  const x = r.segments.find((s) => s.place && s.place.id === 'X2');
  assert.equal(x.type, 'LIKELY_RESTAURANT_VISIT');
  assert.equal(x.notInPlan, true);
  assert.equal(r.segments.find((s) => s.place && s.place.id === 'P2').notInPlan, false);
  assert.deepEqual(j.notInPlan.map((v) => [v.placeName, v.kind]), [['Restaurant X2', 'visited']]);
});
