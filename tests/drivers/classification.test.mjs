// Classification rules — especially the three refusals that keep the business
// total honest:
//   never PERSONAL from geometry, never BUSINESS from proximity, never
//   "a delivery happened" from a visit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { PLACES } from './helpers/journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

function classify(points, ctx = {}) {
  const t = cleanTrack(points, CFG, T0 + 12 * 3600 * 1000);
  const stops = detectStops(t.points, CFG);
  const { segments } = buildSegments(t.points, t.hops, stops);
  return {
    track: t,
    segments: classifySegments(segments, t.points, {
      driverId: 'drv1',
      facilities: [PLACES.DAIRY],
      restaurants: [PLACES.RESTAURANT_A, PLACES.RESTAURANT_B],
      orders: [], declarations: [], reviews: [],
      ...ctx,
    }, CFG),
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

test('an unrecognised stop is UNKNOWN — never PERSONAL, never BUSINESS', () => {
  const { segments } = classify(track([{ at: PLACES.DAIRY }, { at: PLACES.PERSONAL_1 }, { at: PLACES.PERSONAL_2 }]));
  const stops = segments.filter((s) => s.kind === 'stop');
  for (const s of stops.slice(1)) {
    assert.equal(s.type, SEGMENT_TYPE.UNKNOWN, 'geometry alone must never conclude personal or business');
    assert.equal(s.needsReview, true);
    assert.ok(s.evidence.some((e) => e.code === 'no_known_location'));
  }
});

test('being NEAR a restaurant is not being AT one', () => {
  // 400 m from Restaurant A — well outside its 80 m geofence.
  const nearby = { lat: PLACES.RESTAURANT_A.lat + 400 / 111320, lng: PLACES.RESTAURANT_A.lng };
  const { segments } = classify(track([{ at: PLACES.DAIRY }, { at: nearby }]));
  const stop = segments.filter((s) => s.kind === 'stop')[1];
  assert.equal(stop.type, SEGMENT_TYPE.UNKNOWN);
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

test('a leg with one unknown end is UNKNOWN, and its distance is not business', () => {
  const { segments } = classify(track([{ at: PLACES.RESTAURANT_A }, { at: PLACES.PERSONAL_1 }]));
  const leg = segments.find((s) => s.kind === 'travel' && s.distanceM > 100);
  assert.equal(leg.type, SEGMENT_TYPE.UNKNOWN);
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
  const target = plain.segments.find((s) => s.type === SEGMENT_TYPE.UNKNOWN);
  const reviewed = classify(points, {
    reviews: [{ id: 'rev1', segmentId: target.id, toType: SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS, reviewerId: 'admin:owner', at: T0, note: 'Porter job' }],
  });
  const after = reviewed.segments.find((s) => s.id === target.id);
  assert.equal(after.type, SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS);
  assert.equal(after.originalType, SEGMENT_TYPE.UNKNOWN);
  assert.equal(after.needsReview, false);
  assert.ok(after.evidence.some((e) => e.code === 'admin_review'));
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
