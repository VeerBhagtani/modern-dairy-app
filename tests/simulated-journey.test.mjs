// The acceptance scenario from the brief, end to end:
//
//   Modern Dairy → Restaurant A → Restaurant B → Personal 1 → 2 → 3
//                → Modern Dairy → Restaurant C → Restaurant D → Modern Dairy
//
// synthesised at 30-second sampling from real Pune coordinates, with GPS noise,
// a six-minute tunnel gap and one 4 km multipath spike injected.
//
// Every assertion here is one of the requirements in Part 20 of the brief. If
// one of them fails, the platform is claiming something it cannot support.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { fullDayJourney, FACILITIES, RESTAURANTS, PLACES, haversine } from './helpers/journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { SEGMENT_TYPE, CONFIDENCE } = require('./src/drivers/classification');
const { OUTCOME } = require('./src/drivers/matching');

// One fixed input for the whole file: the same raw points every test sees, so
// a failure is about the code and never about the fixture.
const POINTS = Object.freeze(fullDayJourney({ seed: 2026, gapAfterWaypoint: 4, spikeAfterIndex: 60 }));
const NOW = POINTS[POINTS.length - 1].deviceTs + 60000;
const RIDE = { id: 'ride-sim-1', driverId: 'drv-sim-1', startedAt: POINTS[0].deviceTs };

function run(extra = {}) {
  return processRideData({
    points: POINTS.map((p) => ({ ...p })),   // defensive copy: the pipeline must not mutate its input
    ride: RIDE,
    facilities: FACILITIES,
    restaurants: RESTAURANTS,
    orders: [],
    declarations: [],
    reviews: [],
    nowMs: NOW,
    ...extra,
  });
}

const BASE = run();

test('the entire journey is recorded', () => {
  assert.equal(BASE.counts.points, POINTS.length);
  // Ten waypoints, so ten dwell clusters, and travel legs between them.
  assert.ok(BASE.counts.stops >= 9, `only ${BASE.counts.stops} stops detected`);
  assert.ok(BASE.counts.segments >= 17);
  // The whole working day, start to finish.
  const spanHours = (BASE.track.totals.lastTs - BASE.track.totals.firstTs) / 3600000;
  assert.ok(spanHours > 2, `journey spans only ${spanHours.toFixed(1)} h`);
});

test('restaurant visits are detected — as LIKELY visits, not as proven deliveries', () => {
  const visits = BASE.segments.filter((s) => s.type === SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT);
  assert.equal(visits.length, 4, 'all four restaurants should be recognised');
  assert.deepEqual(
    visits.map((v) => v.place.id).sort(),
    ['res_a', 'res_b', 'res_c', 'res_d'],
  );
  // With no order data, none of them may claim HIGH confidence.
  for (const v of visits) {
    assert.equal(v.confidence, CONFIDENCE.MEDIUM);
    assert.ok(v.evidence.some((e) => e.code === 'no_order_data'));
  }
  // And the type itself says "likely", never "delivered".
  assert.ok(!BASE.segments.some((s) => /DELIVER/i.test(s.type)));
});

test('the three Modern Dairy calls are recognised as facility stops', () => {
  const facility = BASE.segments.filter((s) => s.type === SEGMENT_TYPE.MODERN_DAIRY_FACILITY_STOP);
  assert.equal(facility.length, 3, 'start, mid-day reload and end of day');
  for (const f of facility) assert.equal(f.confidence, CONFIDENCE.HIGH);
});

test('personal stops are NEVER classified as business', () => {
  // The three Porter customers are at coordinates the system has never seen:
  // not restaurants, not the depot — so, by the restaurant rule, personal.
  for (const place of [PLACES.PERSONAL_1, PLACES.PERSONAL_2, PLACES.PERSONAL_3]) {
    const near = BASE.segments.filter((s) => s.kind === 'stop' && s.center
      && haversine(s.center, place) < 200);
    assert.equal(near.length, 1, `no stop found at ${place.name}`);
    assert.equal(near[0].type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS,
      `${place.name} was classified as ${near[0].type}`);
  }
});

test('the Porter detour is personal, and the restaurant rounds are business', () => {
  // Restaurant B → Personal 1 → 2 → 3 → Modern Dairy leads to no restaurant:
  // several kilometres of personal driving, kept out of business entirely.
  assert.ok(BASE.distance.km.personal > 5, `expected the Porter detour in personal, got ${BASE.distance.km.personal} km`);
  assert.ok(BASE.distance.km.likelyBusiness > 5, 'and the deliveries in business');
  // Nothing in this day is left undecided: every leg either leads to a
  // restaurant or it does not. Only the tunnel gap stays separate.
  assert.ok(BASE.distance.km.unknown < 0.5, `unknown should be near zero, got ${BASE.distance.km.unknown} km`);
  assert.equal(BASE.review.unknownKm, BASE.distance.km.unknown);
});

test('the verified business total contains no uncertain kilometres', () => {
  // Without order records nothing reaches HIGH except facility-to-facility
  // travel, so the verified figure is small and the likely figure carries the
  // rest. That is the honest answer, and the test pins it.
  const verifiedSegments = BASE.segments.filter((s) => s.confidence === CONFIDENCE.HIGH && s.distanceM > 0);
  for (const s of verifiedSegments) {
    assert.ok(!s.needsReview, `${s.id} is in the verified total but flagged for review`);
  }
  assert.ok(BASE.distance.km.likelyBusiness > 0, 'the medium-confidence work must be reported, separately');
  assert.ok(
    BASE.distance.km.verifiedBusiness + BASE.distance.km.likelyBusiness < BASE.distance.km.dayTotal,
    'business distance cannot be the whole day when part of the day is unclassified',
  );
});

test('distance is not double-counted, and the buckets reconcile', () => {
  const m = BASE.distance.metres;
  assert.equal(BASE.distance.reconciliation.ok, true, JSON.stringify(BASE.distance.reconciliation));
  const sum = m.verifiedBusiness + m.likelyBusiness + m.personal + m.unknown + m.invalid;
  assert.ok(Math.abs(sum - m.measured) <= 2, `buckets ${sum} vs measured ${m.measured}`);
  assert.ok(Math.abs((m.measured + m.gapEstimate) - m.dayTotal) <= 2);

  // Sanity against the geometry: the straight-line sum of the waypoints is the
  // lower bound of any honest measurement of this route.
  const legs = [PLACES.DAIRY, PLACES.RESTAURANT_A, PLACES.RESTAURANT_B, PLACES.PERSONAL_1,
    PLACES.PERSONAL_2, PLACES.PERSONAL_3, PLACES.DAIRY, PLACES.RESTAURANT_C,
    PLACES.RESTAURANT_D, PLACES.DAIRY];
  let straight = 0;
  for (let i = 1; i < legs.length; i += 1) straight += haversine(legs[i - 1], legs[i]);
  assert.ok(m.dayTotal > straight * 0.9, `measured ${m.dayTotal} m is implausibly short vs ${Math.round(straight)} m of legs`);
  assert.ok(m.dayTotal < straight * 1.15, `measured ${m.dayTotal} m is implausibly long vs ${Math.round(straight)} m of legs — something is being counted twice`);
});

test('the injected GPS spike is rejected and contributes nothing', () => {
  assert.equal(BASE.track.totals.byReason.implausible_jump, 1);
  const clean = processRideData({
    points: POINTS.filter((p) => !p.clientPointId.endsWith(':spike')),
    ride: RIDE, facilities: FACILITIES, restaurants: RESTAURANTS,
    orders: [], declarations: [], reviews: [], nowMs: NOW,
  });
  assert.ok(Math.abs(clean.distance.metres.dayTotal - BASE.distance.metres.dayTotal) <= 2,
    'removing the spike should change nothing, because it was already excluded');
});

test('the tracking gap is estimated, labelled, and kept out of business distance', () => {
  assert.equal(BASE.track.gaps.length, 1);
  assert.ok(BASE.track.gaps[0].seconds >= 360);
  assert.ok(BASE.distance.metres.gapEstimate > 0);
  // No segment may carry gap distance inside a verified business figure.
  for (const s of BASE.segments) {
    if (s.gapEstimateM > 0) assert.ok(s.needsReview, `${s.id} carries an estimate but is not flagged`);
  }
  const perSeg = BASE.distance.perSegment.filter((p) => p.gapEstimateM > 0);
  assert.ok(perSeg.every((p) => p.method === 'estimated' || p.method === 'mixed'));
});

test('raw GPS is never modified by processing', () => {
  const before = JSON.stringify(POINTS);
  run();
  run({ declarations: [{ kind: 'personal', fromTs: 0, toTs: NOW, declaredAt: 0 }] });
  assert.equal(JSON.stringify(POINTS), before, 'the pipeline mutated its input');
});

test('the same input always produces the same output', () => {
  const a = run();
  const b = run();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('order records raise the matching visits to verified, and only those', () => {
  const visitA = BASE.segments.find((s) => s.place && s.place.id === 'res_a');
  const withOrders = run({
    orders: [{
      id: 'SO-1', customerId: 'CUST-A', assignedDriverId: 'drv-sim-1', placeId: 'res_a',
      orderedAt: visitA.startTs - 3600000, windowStart: visitA.startTs - 3600000, windowEnd: visitA.endTs + 3600000,
      status: 'dispatched',
    }],
  });
  const a2 = withOrders.segments.find((s) => s.place && s.place.id === 'res_a');
  assert.equal(a2.confidence, CONFIDENCE.HIGH);
  // The other restaurants have no order and must not have moved.
  const b2 = withOrders.segments.find((s) => s.place && s.place.id === 'res_b');
  assert.equal(b2.confidence, CONFIDENCE.MEDIUM);
  // Verified business distance went up, and the day total did not change.
  assert.ok(withOrders.distance.metres.verifiedBusiness > BASE.distance.metres.verifiedBusiness);
  assert.equal(withOrders.distance.metres.dayTotal, BASE.distance.metres.dayTotal);
  // The match is recorded with its evidence.
  assert.equal(withOrders.matching.summary.matched, 1);
  assert.equal(withOrders.matching.matches[0].outcome, OUTCOME.MATCHED);
});

test('a driver declaration moves the Porter leg out of business, never into it', () => {
  const p1 = BASE.segments.find((s) => s.kind === 'stop' && s.center && haversine(s.center, PLACES.PERSONAL_1) < 200);
  const p3 = BASE.segments.find((s) => s.kind === 'stop' && s.center && haversine(s.center, PLACES.PERSONAL_3) < 200);
  const declared = run({
    declarations: [{ kind: 'personal', fromTs: p1.startTs - 60000, toTs: p3.endTs + 60000, declaredAt: NOW }],
  });
  assert.ok(declared.distance.metres.personal > 0, 'the declared stretch should land in the personal bucket');
  assert.ok(declared.distance.metres.personal >= BASE.distance.metres.personal, 'a declaration only ever adds to personal');
  // It can never increase the business figure.
  assert.ok(declared.distance.metres.verifiedBusiness <= BASE.distance.metres.verifiedBusiness);
  assert.ok(declared.distance.metres.likelyBusiness <= BASE.distance.metres.likelyBusiness);
  // The day total is untouched: classification moves kilometres between
  // buckets, it never creates or destroys them.
  assert.equal(declared.distance.metres.dayTotal, BASE.distance.metres.dayTotal);
  assert.equal(declared.distance.reconciliation.ok, true);
});

test('an admin can correct a classification, with the original preserved', () => {
  const target = BASE.segments.find((s) => s.kind === 'travel' && s.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS && s.distanceM > 1000);
  assert.ok(target, 'expected at least one substantial personal leg to review');
  const reviewed = run({
    reviews: [{
      id: 'rev-1', segmentId: target.id, toType: SEGMENT_TYPE.BUSINESS_TRAVEL,
      reviewerId: 'admin:owner', at: NOW, note: 'Collected empties for the dairy on the way',
    }],
  });
  const after = reviewed.segments.find((s) => s.id === target.id);
  assert.equal(after.type, SEGMENT_TYPE.BUSINESS_TRAVEL);
  assert.equal(after.originalType, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  assert.equal(after.originalConfidence, target.confidence);
  assert.equal(after.reviewedBy, 'admin:owner');
  assert.ok(after.evidence.some((e) => e.code === 'admin_review'));
  assert.equal(reviewed.distance.metres.dayTotal, BASE.distance.metres.dayTotal);
  assert.equal(reviewed.distance.reconciliation.ok, true);
});

test('every classification carries the evidence behind it', () => {
  for (const s of BASE.segments) {
    assert.ok(Array.isArray(s.evidence) && s.evidence.length > 0, `${s.id} (${s.type}) has no evidence`);
    for (const e of s.evidence) {
      assert.ok(e.code && e.detail, `${s.id} has an evidence entry with no explanation`);
    }
  }
});

test('the thresholds used are recorded on the result', () => {
  assert.ok(BASE.calcVersion);
  assert.equal(typeof BASE.configUsed.stopRadiusM, 'number');
  assert.equal(BASE.configUsed.stopMinDwellSec, 180);
  // A config override is honoured and visible.
  const loose = run({ configOverrides: { stopMinDwellSec: 3600 } });
  assert.equal(loose.configUsed.stopMinDwellSec, 3600);
  assert.ok(loose.counts.stops < BASE.counts.stops, 'a longer dwell threshold must find fewer stops');
});

test('an out-of-range threshold is rejected loudly, not clamped quietly', () => {
  const r = run({ configOverrides: { stopRadiusM: 999999, nonsenseKey: 1 } });
  assert.equal(r.configUsed.stopRadiusM, 60, 'the default must stand');
  assert.equal(r.configRejected.length, 2);
  assert.ok(r.configRejected.some((x) => x.key === 'stopRadiusM' && /out of range/.test(x.reason)));
  assert.ok(r.configRejected.some((x) => x.key === 'nonsenseKey'));
});

test('per-visit distances sum to no more than the journey (no double-counting)', () => {
  const sum = BASE.visits.reduce((s, v) => s + v.approachDistanceM, 0);
  assert.ok(sum <= BASE.distance.metres.measured + 2, `visit approaches ${sum} m exceed the measured total`);
  assert.equal(BASE.visits.length, 4);
  for (const v of BASE.visits) assert.ok(v.approachDistanceM > 0);
});
