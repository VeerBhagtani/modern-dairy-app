// Classification rules. Business and personal are decided by the restaurants:
// driving to a restaurant, and between restaurants and the depot, is business;
// driving that does not lead to one is personal. And the refusals that keep
// the business total honest: never BUSINESS from proximity, never a decision
// from a doubtful visit, never "a delivery happened" from a visit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { PLACES } from './helpers/journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { resolveConfig } = require('./src/drivers/config');
const { cleanTrack } = require('./src/drivers/track');
const { detectStops } = require('./src/drivers/stops');
const { buildSegments } = require('./src/drivers/segmentation');
const { classifySegments, SEGMENT_TYPE, CONFIDENCE } = require('./src/drivers/classification');
const { summariseDistance, bucketFor, BUCKET } = require('./src/drivers/distance');

const { config: CFG } = resolveConfig();
const T0 = Date.parse('2026-09-15T03:30:00Z');

// Build a track that travels between a list of places, dwelling at each.
function track(stops) {
  const points = [];
  let ts = T0;
  let i = 0;
  const push = (lat, lng) => {
    points.push({ clientPointId: `d:${String(i += 1).padStart(5, '0')}`, lat, lng, deviceTs: ts, accuracyM: 8 });
    ts += 30000;
  };
  for (let s = 0; s < stops.length; s += 1) {
    const { at, dwellSec = 600 } = stops[s];
    for (let t = 0; t < dwellSec; t += 30) push(at.lat, at.lng);
    const next = stops[s + 1];
    if (!next) break;
    for (let k = 1; k <= 12; k += 1) {
      push(at.lat + (next.at.lat - at.lat) * (k / 12), at.lng + (next.at.lng - at.lng) * (k / 12));
    }
  }
  return points;
}

function classify(points, ctx = {}, overrides = null) {
  const cfg = overrides ? resolveConfig(overrides).config : CFG;
  const t = cleanTrack(points, cfg, T0 + 12 * 3600 * 1000);
  const stops = detectStops(t.points, cfg);
  const { segments } = buildSegments(t.points, t.hops, stops);
  return {
    track: t,
    segments: classifySegments(segments, t.points, {
      driverId: 'drv1',
      facilities: [PLACES.DAIRY],
      restaurants: [PLACES.RESTAURANT_A, PLACES.RESTAURANT_B],
      orders: [], declarations: [], reviews: [],
      ...ctx,
    }, cfg),
  };
}

test('a stop inside a Modern Dairy geofence is a facility stop, HIGH confidence', () => {
  const { segments } = classify(track([{ at: PLACES.DAIRY }, { at: PLACES.RESTAURANT_A }]));
  const first = segments.find((s) => s.kind === 'stop');
  assert.equal(first.type, SEGMENT_TYPE.MODERN_DAIRY_FACILITY_STOP);
  assert.equal(first.confidence, CONFIDENCE.HIGH);
  assert.ok(first.evidence.some((e) => e.code === 'facility_geofence'));
});

test('a restaurant visit with no order data caps at MEDIUM — and says why', () => {
  const { segments } = classify(track([{ at: PLACES.DAIRY }, { at: PLACES.RESTAURANT_A }]));
  const visit = segments.filter((s) => s.kind === 'stop')[1];
  assert.equal(visit.type, SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT);
  assert.equal(visit.confidence, CONFIDENCE.MEDIUM);
  assert.ok(visit.evidence.some((e) => e.code === 'no_order_data'),
    'the reason it is only MEDIUM must be on the record');
});

test('a matching delivery order raises the same visit to HIGH', () => {
  const points = track([{ at: PLACES.DAIRY }, { at: PLACES.RESTAURANT_A }]);
  const { segments } = classify(points, {
    orders: [{
      id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv1',
      orderedAt: T0, windowStart: T0, windowEnd: T0 + 4 * 3600 * 1000, status: 'dispatched',
    }],
  });
  const visit = segments.filter((s) => s.kind === 'stop')[1];
  assert.equal(visit.confidence, CONFIDENCE.HIGH);
  assert.ok(visit.evidence.some((e) => e.code === 'order_record'));
  // Still a LIKELY visit — the order does not prove the handover occurred.
  assert.equal(visit.type, SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT);
});

test('a stop that is not a restaurant or the depot is personal — never business', () => {
  const { segments } = classify(track([{ at: PLACES.DAIRY }, { at: PLACES.PERSONAL_1 }, { at: PLACES.PERSONAL_2 }]));
  const stops = segments.filter((s) => s.kind === 'stop');
  for (const s of stops.slice(1)) {
    assert.equal(s.type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS, 'not a customer, so not business');
    assert.notEqual(bucketFor(s), BUCKET.VERIFIED_BUSINESS);
    assert.notEqual(bucketFor(s), BUCKET.LIKELY_BUSINESS);
    assert.ok(s.evidence.some((e) => e.code === 'no_known_location'));
  }
});

test('travel to a restaurant is business, and travel that leads to none is personal', () => {
  // Personal place → restaurant → personal place: the first leg is a trip to
  // a customer, the second leaves the last customer for somewhere else.
  const { segments } = classify(track([{ at: PLACES.PERSONAL_1 }, { at: PLACES.RESTAURANT_A }, { at: PLACES.PERSONAL_2 }]));
  const legs = segments.filter((s) => s.kind === 'travel' && s.distanceM > 100);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].type, SEGMENT_TYPE.BUSINESS_TRAVEL);
  assert.equal(bucketFor(legs[0]), BUCKET.LIKELY_BUSINESS, 'business, but not verified: where it began is not known to be work');
  assert.equal(legs[1].type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  assert.equal(bucketFor(legs[1]), BUCKET.PERSONAL);
});

test('a commute to the depot is personal, the round from it is business', () => {
  const { segments } = classify(track([
    { at: PLACES.PERSONAL_1 }, { at: PLACES.DAIRY }, { at: PLACES.RESTAURANT_A }, { at: PLACES.DAIRY },
  ]));
  const legs = segments.filter((s) => s.kind === 'travel' && s.distanceM > 100).map((s) => s.type);
  assert.deepEqual(legs, [
    SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS,
    SEGMENT_TYPE.MODERN_DAIRY_DEPARTURE,
    SEGMENT_TYPE.RETURN_TO_MODERN_DAIRY,
  ]);
});

test('being NEAR a restaurant is not being AT one', () => {
  // 400 m from Restaurant A — well outside its 80 m geofence.
  const nearby = { lat: PLACES.RESTAURANT_A.lat + 400 / 111320, lng: PLACES.RESTAURANT_A.lng };
  const { segments } = classify(track([{ at: PLACES.DAIRY }, { at: nearby }]));
  const stop = segments.filter((s) => s.kind === 'stop')[1];
  assert.equal(stop.type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS, 'near is not at: not business');
  // The nearby restaurant is offered to the reviewer as context, clearly
  // labelled as proximity rather than as a match.
  assert.ok(stop.nearbyPlaces && stop.nearbyPlaces.length);
  assert.ok(!stop.evidence.some((e) => e.code === 'geofence_match'));
});

test('a driver declaration makes a stretch personal, and is recorded as the reason', () => {
  const points = track([{ at: PLACES.DAIRY }, { at: PLACES.PERSONAL_1 }, { at: PLACES.DAIRY }]);
  const mid = points[Math.floor(points.length / 2)].deviceTs;
  const { segments } = classify(points, {
    declarations: [{ kind: 'personal', fromTs: mid - 1800000, toTs: mid + 1800000, declaredAt: T0, note: 'Porter drop' }],
  });
  const personal = segments.filter((s) => s.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  assert.ok(personal.length > 0);
  assert.ok(personal[0].evidence.some((e) => e.code === 'driver_declared'));
});

test('a declaration over a geofenced visit still wins, but is flagged as a conflict', () => {
  const points = track([{ at: PLACES.DAIRY }, { at: PLACES.RESTAURANT_A }]);
  const { segments } = classify(points, {
    declarations: [{ kind: 'personal', fromTs: T0, toTs: T0 + 12 * 3600 * 1000, declaredAt: T0 }],
  });
  const visit = segments.filter((s) => s.kind === 'stop')[1];
  assert.equal(visit.type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  assert.equal(visit.needsReview, true, 'a driver contradicting a geofence must reach a human');
  assert.ok(visit.evidence.some((e) => e.code === 'conflicting_evidence'));
});

test('two overlapping geofences produce LOW confidence and a review flag, not a guess', () => {
  const twin = { id: 'res_twin', name: 'Twin', customerId: 'CUST-T', lat: PLACES.RESTAURANT_A.lat + 0.0002, lng: PLACES.RESTAURANT_A.lng, radiusM: 120 };
  const { segments } = classify(track([{ at: PLACES.DAIRY }, { at: PLACES.RESTAURANT_A }]), {
    restaurants: [PLACES.RESTAURANT_A, twin],
  });
  const visit = segments.filter((s) => s.kind === 'stop')[1];
  assert.equal(visit.confidence, CONFIDENCE.LOW);
  assert.equal(visit.needsReview, true);
  assert.equal(visit.ambiguousPlaces.length, 2);
});

test('leaving the last restaurant for somewhere else is personal, never business', () => {
  const { segments } = classify(track([{ at: PLACES.RESTAURANT_A }, { at: PLACES.PERSONAL_1 }]));
  const leg = segments.find((s) => s.kind === 'travel' && s.distanceM > 100);
  assert.equal(leg.type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  assert.equal(bucketFor(leg), BUCKET.PERSONAL);
});

test('a personal stop just outside a customer\'s geofence is flagged — the pin may be wrong', () => {
  // 150 m from Restaurant A: outside its 80 m geofence, so not a visit, but
  // close enough that a misplaced pin is the likeliest explanation.
  const close = { lat: PLACES.RESTAURANT_A.lat + 150 / 111320, lng: PLACES.RESTAURANT_A.lng };
  const { segments } = classify(track([{ at: PLACES.DAIRY }, { at: close }]));
  const stop = segments.filter((s) => s.kind === 'stop')[1];
  assert.equal(stop.type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  assert.equal(stop.needsReview, true);
  assert.ok(stop.evidence.some((e) => e.code === 'near_known_place'));
  const leg = segments.find((s) => s.kind === 'travel' && s.distanceM > 100);
  assert.equal(leg.needsReview, true, 'and so is the leg that ends there');
});

test('a doubtful restaurant visit decides nothing: its legs stay unknown for review', () => {
  // Two customers pinned on the same spot: the stop is at a restaurant, but
  // which one is in doubt, and the leg to it is not decided either way.
  const twin = { ...PLACES.RESTAURANT_A, id: 'twin', name: 'Restaurant A twin' };
  const { segments } = classify(track([{ at: PLACES.PERSONAL_1 }, { at: PLACES.RESTAURANT_A }]),
    { restaurants: [PLACES.RESTAURANT_A, twin, PLACES.RESTAURANT_B] });
  const visit = segments.find((s) => s.type === SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT);
  assert.equal(visit.confidence, CONFIDENCE.LOW);
  const leg = segments.find((s) => s.kind === 'travel' && s.distanceM > 100);
  assert.equal(leg.type, SEGMENT_TYPE.UNKNOWN);
  assert.equal(leg.needsReview, true);
  assert.equal(bucketFor(leg), BUCKET.UNKNOWN);
});

test('only HIGH-confidence business distance reaches the verified total', () => {
  const mediumVisit = { type: SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT, confidence: CONFIDENCE.MEDIUM };
  const highTravel = { type: SEGMENT_TYPE.TRAVEL_BETWEEN_BUSINESS_LOCATIONS, confidence: CONFIDENCE.HIGH };
  const lowTravel = { type: SEGMENT_TYPE.TRAVEL_BETWEEN_BUSINESS_LOCATIONS, confidence: CONFIDENCE.LOW };
  assert.equal(bucketFor(mediumVisit), BUCKET.LIKELY_BUSINESS);
  assert.equal(bucketFor(highTravel), BUCKET.VERIFIED_BUSINESS);
  assert.equal(bucketFor(lowTravel), BUCKET.UNKNOWN, 'LOW-confidence business-looking distance is NOT business');
});

test('an admin review overrides the machine and keeps the original on the record', () => {
  const points = track([{ at: PLACES.DAIRY }, { at: PLACES.PERSONAL_1 }]);
  const plain = classify(points);
  const target = plain.segments.find((s) => s.kind === 'travel' && s.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  const reviewed = classify(points, {
    reviews: [{ id: 'rev1', segmentId: target.id, toType: SEGMENT_TYPE.BUSINESS_TRAVEL, reviewerId: 'admin:owner', at: T0, note: 'new customer, not on the map yet' }],
  });
  const after = reviewed.segments.find((s) => s.id === target.id);
  assert.equal(after.type, SEGMENT_TYPE.BUSINESS_TRAVEL);
  assert.equal(after.originalType, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  assert.equal(after.needsReview, false);
  assert.ok(after.evidence.some((e) => e.code === 'admin_review'));
});

test('a review pinned to a different time window is NOT applied', () => {
  // Segment ids are positional. If a reprocess changes the segmentation — a
  // threshold edit, or late points arriving — a decision must not silently
  // re-attach itself to a different stretch of the day.
  const points = track([{ at: PLACES.DAIRY }, { at: PLACES.PERSONAL_1 }]);
  const plain = classify(points);
  const target = plain.segments.find((s) => s.kind === 'travel' && s.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);

  const matching = classify(points, {
    reviews: [{ id: 'r1', segmentId: target.id, toType: SEGMENT_TYPE.BUSINESS_TRAVEL, reviewerId: 'admin:owner', at: T0, segStartTs: target.startTs, segEndTs: target.endTs }],
  }).segments.find((s) => s.id === target.id);
  assert.equal(matching.type, SEGMENT_TYPE.BUSINESS_TRAVEL, 'a review whose window still matches must apply');

  const stale = classify(points, {
    reviews: [{ id: 'r1', segmentId: target.id, toType: SEGMENT_TYPE.BUSINESS_TRAVEL, reviewerId: 'admin:owner', at: T0, segStartTs: target.startTs + 7200000, segEndTs: target.endTs + 7200000 }],
  }).segments.find((s) => s.id === target.id);
  assert.equal(stale.type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS, 'a review from a different window must not be applied');
  assert.equal(stale.needsReview, true);
  assert.equal(stale.staleReviewId, 'r1');
  assert.ok(stale.evidence.some((e) => e.code === 'stale_review'));
});

test('an older review with no pinned window still applies, for backward compatibility', () => {
  const points = track([{ at: PLACES.DAIRY }, { at: PLACES.PERSONAL_1 }]);
  const target = classify(points).segments.find((s) => s.kind === 'travel' && s.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  const after = classify(points, {
    reviews: [{ id: 'old', segmentId: target.id, toType: SEGMENT_TYPE.BUSINESS_TRAVEL, reviewerId: 'admin:owner', at: T0 }],
  }).segments.find((s) => s.id === target.id);
  assert.equal(after.type, SEGMENT_TYPE.BUSINESS_TRAVEL);
});

test('the buckets always reconcile with the measured total', () => {
  const { track: t, segments } = classify(track([
    { at: PLACES.DAIRY }, { at: PLACES.RESTAURANT_A }, { at: PLACES.RESTAURANT_B },
    { at: PLACES.PERSONAL_1 }, { at: PLACES.DAIRY },
  ]));
  const d = summariseDistance(segments, t.totals);
  assert.equal(d.reconciliation.ok, true, JSON.stringify(d.reconciliation));
  const sum = d.metres.verifiedBusiness + d.metres.likelyBusiness + d.metres.personal + d.metres.unknown + d.metres.invalid;
  assert.ok(Math.abs(sum - d.metres.measured) <= 2, 'buckets must sum to the measured total');
  assert.ok(Math.abs((d.metres.measured + d.metres.gapEstimate) - d.metres.dayTotal) <= 2);
});
