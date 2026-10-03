// The complete journey of a ride: every stop in order (unknown ones too),
// travel between them measured along the GPS, nothing dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { buildReplay } = require('./src/services/replay');
const { buildJourney, CATEGORY } = require('./src/drivers/journey');
const { haversineM } = require('./src/drivers/geo');

const T0 = Date.parse('2026-10-03T02:30:00Z');   // 08:00 IST
const M = (dx, dy) => ({ lat: 18.50 + dy / 111320, lng: 73.86 + dx / (111320 * Math.cos(18.5 * Math.PI / 180)) });
const DEPOT = { id: 'depot', name: 'Modern Dairy, Market Yard', ...M(0, 0), radiusM: 150 };
const A = { id: 'A', name: 'Restaurant A', customerId: 'CA', address: 'FC Road', ...M(2400, 0), radiusM: 80 };
const B = { id: 'B', name: 'Restaurant B', customerId: 'CB', ...M(2400, 1800), radiusM: 80 };
const C = { id: 'C', name: 'Restaurant C', customerId: 'CC', ...M(-2000, 1200), radiusM: 80 };
const PORTER = M(5000, 3500);                     // nobody we know

// Drive in straight lines at ~8 m/s, a fix every 20 s; dwell at each stop.
function day(stops) {
  const pts = []; let t = T0; let n = 0; let here = stops[0].at;
  const fix = (p) => { pts.push({ clientPointId: `p${n += 1}`, lat: p.lat, lng: p.lng, deviceTs: t, accuracyM: 8, speedMps: 0 }); t += 20000; };
  for (const s of stops) {
    const dist = haversineM(here, s.at); const steps = Math.max(1, Math.round(dist / 160));
    for (let k = 1; k <= steps; k += 1) fix({ lat: here.lat + (s.at.lat - here.lat) * k / steps, lng: here.lng + (s.at.lng - here.lng) * k / steps });
    for (let k = 0; k < (s.dwellSec || 360) / 20; k += 1) fix(s.at);
    here = s.at;
  }
  return pts;
}
const PLAN = [{ at: DEPOT }, { at: A }, { at: B }, { at: PORTER, dwellSec: 900 }, { at: DEPOT }, { at: C }, { at: DEPOT }];
const POINTS = day(PLAN);
const ride = { id: 'r1', driverId: 'd1', startedAt: T0, status: 'completed' };
const places = { facilities: [DEPOT], restaurants: [A, B, C] };
const proc = processRideData({ points: POINTS, ride, facilities: [DEPOT], restaurants: [A, B, C], orders: [], declarations: [], reviews: [], nowMs: T0 + 864e5 });
const replay = buildReplay(POINTS, { ...proc, processedAt: T0 + 864e5 });
const J = buildJourney({ ride, processing: proc, replay, places });

test('every stop, in order, including the unknown one — nothing merged, nothing hidden', () => {
  const seq = J.stops.map((s) => `${s.category}:${s.placeName || '-'}`);
  assert.deepEqual(seq, [
    'MODERN_DAIRY:Modern Dairy, Market Yard', 'RESTAURANT:Restaurant A', 'RESTAURANT:Restaurant B',
    'UNKNOWN:-', 'MODERN_DAIRY:Modern Dairy, Market Yard', 'RESTAURANT:Restaurant C', 'MODERN_DAIRY:Modern Dairy, Market Yard',
  ]);
  const unknown = J.stops[3];
  assert.equal(unknown.label, 'Unknown stop', 'never assumed personal');
  assert.ok(Math.abs(unknown.durationSec - 900) <= 40);
  assert.ok(haversineM(unknown, PORTER) < 30);
  for (const s of J.stops) assert.ok(s.arrivalTs && s.departureTs && s.durationSec > 0 && Number.isFinite(s.lat));
  assert.equal(J.totals.unknownStops, 1);
  assert.equal(J.totals.restaurantsVisited, 3);
});

test('distances are measured along the GPS, and add up to the ride total', () => {
  // Depot → A is 2.4 km, A → B 1.8 km: along the recorded points.
  assert.ok(Math.abs(J.stops[1].distanceFromPrevM - 2400) < 60, `depot→A ${J.stops[1].distanceFromPrevM}`);
  assert.ok(Math.abs(J.stops[2].distanceFromPrevM - 1800) < 60, `A→B ${J.stops[2].distanceFromPrevM}`);
  const legs = J.segments.reduce((a, g) => a + g.distanceM, 0);
  assert.equal(legs, J.totals.measuredM, 'segments add up to the total — no stretch missing');
  assert.equal(J.totals.measuredM, Math.round(proc.distance.metres.measured), 'the same figure as the kilometre report');
  // Running total and distance since leaving the depot.
  assert.equal(J.stops[2].totalBeforeM, J.stops[1].distanceFromPrevM + J.stops[2].distanceFromPrevM);
  assert.equal(J.stops[5].sinceDepotM, J.stops[5].distanceFromPrevM, 'C is the first stop after the second depot call');
  assert.equal(J.stops[0].depotStraightM, 0);
  assert.ok(J.stops[1].depotStraightM > 2300);
});

test('the timeline runs start → travel → stop → … → end, from the GPS', () => {
  const kinds = J.events.map((e) => e.kind);
  assert.equal(kinds[0], 'start');
  assert.equal(kinds[kinds.length - 1], 'end');
  assert.equal(J.events[0].label, 'Modern Dairy, Market Yard');
  // Every stop appears, and between consecutive stops there is a travel entry.
  const stopsInTimeline = J.events.filter((e) => e.kind === 'stop').map((e) => e.stop);
  assert.deepEqual(stopsInTimeline, J.stops.map((s) => s.n));
  for (let i = 1; i < J.events.length; i += 1) assert.ok(J.events[i].ts >= J.events[i - 1].ts, 'chronological');
  const travel = J.events.filter((e) => e.kind === 'travel');
  assert.equal(travel.length, 6, 'one leg between each pair of the 7 stops');
});

test('segments say what they counted as; the Porter leg is never business', () => {
  assert.equal(J.segments.length, 6);
  const toPorter = J.segments.find((g) => g.to.n === 4);
  assert.notEqual(toPorter.classification, 'business');
  const toA = J.segments.find((g) => g.to.n === 2);
  assert.equal(toA.classification, 'business');
  for (const g of J.segments) {
    assert.ok(g.startTs < g.endTs && g.durationSec > 0);
    assert.ok(['GOOD', 'FAIR', 'POOR', 'NO_GPS'].includes(g.quality.grade));
  }
});

test('the map gets every fix with its time and running distance — none removed', () => {
  assert.equal(replay.points.length, POINTS.length);
  for (const p of replay.points) assert.ok(Number.isFinite(p.ts) && Number.isFinite(p.d));
  const ds = replay.points.map((p) => p.d);
  for (let i = 1; i < ds.length; i += 1) assert.ok(ds[i] >= ds[i - 1], 'running distance never goes backwards');
});

test('two visits to the same restaurant stay two visits', () => {
  const twice = day([{ at: DEPOT }, { at: A }, { at: B }, { at: A }, { at: DEPOT }]);
  const p2 = processRideData({ points: twice, ride, facilities: [DEPOT], restaurants: [A, B], orders: [], declarations: [], reviews: [], nowMs: T0 + 864e5 });
  const j2 = buildJourney({ ride, processing: p2, replay: buildReplay(twice, { ...p2, processedAt: T0 + 864e5 }), places });
  const aVisits = j2.stops.filter((s) => s.placeId === 'A');
  assert.equal(aVisits.length, 2);
  assert.ok(aVisits[1].arrivalTs > aVisits[0].departureTs);
});

test('a running ride: the last stop has no departure yet, and the timeline ends "now"', () => {
  const live = day([{ at: DEPOT }, { at: A }]);
  const r2 = { ...ride, status: 'active', stoppedAt: null };
  const p3 = processRideData({ points: live, ride: r2, facilities: [DEPOT], restaurants: [A], orders: [], declarations: [], reviews: [], nowMs: T0 + 3600e3 });
  const j3 = buildJourney({ ride: r2, processing: p3, replay: buildReplay(live, { ...p3, processedAt: T0 + 3600e3 }), places });
  assert.equal(j3.active, true);
  assert.equal(j3.stops[j3.stops.length - 1].departureTs, null, 'still there');
  assert.equal(j3.events[j3.events.length - 1].kind, 'now');
});

test('a stop is personal only when somebody said so', () => {
  const porterSeg = proc.segments.find((s) => s.kind === 'stop' && haversineM(s.center, PORTER) < 50);
  const reviewed = processRideData({ points: POINTS, ride, facilities: [DEPOT], restaurants: [A, B, C], orders: [], declarations: [],
    reviews: [{ id: 'rv', segmentId: porterSeg.id, toType: 'PERSONAL_OR_NON_BUSINESS', reviewerId: 'admin:owner', at: T0, segStartTs: porterSeg.startTs, segEndTs: porterSeg.endTs }], nowMs: T0 + 864e5 });
  const j = buildJourney({ ride, processing: reviewed, replay: buildReplay(POINTS, { ...reviewed, processedAt: T0 + 864e5 }), places });
  assert.equal(j.stops[3].category, CATEGORY.PERSONAL);
  assert.equal(j.stops[3].reviewedBy, 'admin:owner');
  // The route itself is unchanged: same fixes, same total.
  assert.equal(j.totals.measuredM, J.totals.measuredM);
  assert.equal(j.totals.fixes, J.totals.fixes);
});

test('an admin can say which restaurant a stop really was; the legs follow; the GPS does not change', () => {
  // The Porter stop was in fact Restaurant C (a new customer pinned wrongly).
  const porterSeg = proc.segments.find((s) => s.kind === 'stop' && haversineM(s.center, PORTER) < 50);
  const reviewed = processRideData({ points: POINTS, ride, facilities: [DEPOT], restaurants: [A, B, C], orders: [], declarations: [],
    reviews: [{ id: 'rv2', segmentId: porterSeg.id, toType: 'LIKELY_RESTAURANT_VISIT', placeId: 'C', reviewerId: 'admin:owner', at: T0, segStartTs: porterSeg.startTs, segEndTs: porterSeg.endTs }], nowMs: T0 + 864e5 });
  const seg = reviewed.segments.find((s) => s.id === porterSeg.id);
  assert.equal(seg.place.id, 'C');
  assert.equal(seg.originalType, 'UNKNOWN');
  const j = buildJourney({ ride, processing: reviewed, replay: buildReplay(POINTS, { ...reviewed, processedAt: T0 + 864e5 }), places });
  assert.equal(j.stops[3].category, CATEGORY.RESTAURANT);
  assert.equal(j.stops[3].placeName, 'Restaurant C');
  // The leg to it is now business travel, decided by the corrected stop.
  const legTo = reviewed.segments.filter((s) => s.kind === 'travel' && s.endTs <= porterSeg.startTs + 1000).pop();
  assert.equal(legTo.type, 'TRAVEL_BETWEEN_BUSINESS_LOCATIONS');
  assert.equal(j.totals.measuredM, J.totals.measuredM, 'same GPS, same distance');
  assert.equal(reviewed.distance.reconciliation.ok, true);
});

test('marking an unknown stop personal makes the trip to it personal too', () => {
  const porterSeg = proc.segments.find((s) => s.kind === 'stop' && haversineM(s.center, PORTER) < 50);
  const reviewed = processRideData({ points: POINTS, ride, facilities: [DEPOT], restaurants: [A, B, C], orders: [], declarations: [],
    reviews: [{ id: 'rv3', segmentId: porterSeg.id, toType: 'PERSONAL_OR_NON_BUSINESS', reviewerId: 'admin:owner', at: T0, segStartTs: porterSeg.startTs, segEndTs: porterSeg.endTs }], nowMs: T0 + 864e5 });
  const legTo = reviewed.segments.filter((s) => s.kind === 'travel' && s.endTs <= porterSeg.startTs + 1000).pop();
  assert.equal(legTo.type, 'PERSONAL_OR_NON_BUSINESS');
  assert.ok(reviewed.distance.metres.personal > 3000);
});
