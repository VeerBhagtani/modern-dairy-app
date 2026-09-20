// Segment classification.
//
// This is the file that decides what Modern Dairy pays for, so every verdict
// it produces carries the evidence that produced it. The dashboard shows that
// evidence next to the verdict, because a kilometre figure a manager cannot
// explain to a driver is worse than no figure at all.
//
// Three rules govern everything below:
//
//  1. Nothing becomes PERSONAL from geometry. Only a driver declaration or an
//     admin review can do that. Geometry's strongest honest statement about an
//     unrecognised stop is UNKNOWN.
//  2. Nothing becomes BUSINESS because it is NEAR a known place. It must be
//     inside the configured geofence and satisfy a dwell rule.
//  3. A restaurant visit is never evidence that a delivery happened. That is a
//     separate engine (matching.js) with a separate verdict field.

const { placesContaining, nearestPlaces, haversineM } = require('./geo');
const { SEGMENT_KIND } = require('./segmentation');

const SEGMENT_TYPE = {
  MODERN_DAIRY_DEPARTURE: 'MODERN_DAIRY_DEPARTURE',
  BUSINESS_TRAVEL: 'BUSINESS_TRAVEL',
  LIKELY_RESTAURANT_VISIT: 'LIKELY_RESTAURANT_VISIT',
  TRAVEL_BETWEEN_BUSINESS_LOCATIONS: 'TRAVEL_BETWEEN_BUSINESS_LOCATIONS',
  PERSONAL_OR_NON_BUSINESS: 'PERSONAL_OR_NON_BUSINESS',
  RETURN_TO_MODERN_DAIRY: 'RETURN_TO_MODERN_DAIRY',
  MODERN_DAIRY_FACILITY_STOP: 'MODERN_DAIRY_FACILITY_STOP',
  UNKNOWN: 'UNKNOWN',
  GPS_GAP_OR_INVALID_DATA: 'GPS_GAP_OR_INVALID_DATA',
};

const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', UNKNOWN: 'UNKNOWN' };
const CONF_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
const weaker = (a, b) => (CONF_RANK[a] <= CONF_RANK[b] ? a : b);

// Types that describe Modern Dairy work. Whether their distance counts as
// VERIFIED business depends on confidence, which is distance.js's job.
const BUSINESS_TYPES = new Set([
  SEGMENT_TYPE.MODERN_DAIRY_DEPARTURE,
  SEGMENT_TYPE.BUSINESS_TRAVEL,
  SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT,
  SEGMENT_TYPE.TRAVEL_BETWEEN_BUSINESS_LOCATIONS,
  SEGMENT_TYPE.RETURN_TO_MODERN_DAIRY,
  SEGMENT_TYPE.MODERN_DAIRY_FACILITY_STOP,
]);

const ev = (code, detail, extra) => ({ code, detail, ...(extra || {}) });

// Does a driver declaration cover this time range? A declaration is a driver
// saying "the next stretch is personal" in the app; it is timestamped on the
// server and can only ever move distance OUT of the business total. That
// asymmetry is the whole reason it is safe to let a driver touch this at all.
function declarationFor(declarations, startTs, endTs) {
  if (!declarations || !declarations.length || startTs == null) return null;
  const mid = endTs != null ? (startTs + endTs) / 2 : startTs;
  return declarations.find((d) => {
    const from = d.fromTs;
    const to = d.toTs == null ? Infinity : d.toTs;
    return mid >= from && mid <= to;
  }) || null;
}

// Orders that support "this stop was a delivery visit to this customer".
// Requires the customer to match, the day to match, and the visit to fall
// inside the delivery window (or within the configured tolerance of it).
// An order assigned to a DIFFERENT driver is not supporting evidence — it is
// a flag, and it is returned as one.
function ordersSupporting(orders, customerId, driverId, startTs, endTs, cfg) {
  const tolMs = cfg.matchTimeToleranceMin * 60000;
  const support = [];
  const otherDriver = [];
  for (const o of orders || []) {
    if (o.customerId !== customerId) continue;
    const winStart = o.windowStart ?? o.orderedAt;
    const winEnd = o.windowEnd ?? o.deliveredAt ?? o.orderedAt;
    if (winStart == null) continue;
    const overlaps = endTs >= winStart - tolMs && startTs <= winEnd + tolMs;
    if (!overlaps) continue;
    if (o.assignedDriverId && driverId && o.assignedDriverId !== driverId) { otherDriver.push(o); continue; }
    support.push(o);
  }
  return { support, otherDriver };
}

/**
 * @param {Array}  segments  from buildSegments
 * @param {Array}  points    annotated points (for boundary place lookups)
 * @param {object} ctx { driverId, facilities, restaurants, orders, declarations, reviews }
 * @param {object} cfg resolved config
 */
function classifySegments(segments, points, ctx, cfg) {
  const facilities = ctx.facilities || [];
  const restaurants = ctx.restaurants || [];
  const out = segments.map((s) => ({ ...s }));

  // ---- pass 1: stops --------------------------------------------------
  for (const seg of out) {
    if (seg.kind !== SEGMENT_KIND.STOP) continue;
    const stop = seg.stop;
    const evidence = [];
    const at = stop.center;

    const facilityHits = placesContaining(at, facilities, cfg.facilityRadiusM);
    const restaurantHits = placesContaining(at, restaurants.filter((r) => r.active !== false), cfg.geofenceDefaultRadiusM);
    const declaration = declarationFor(ctx.declarations, seg.startTs, seg.endTs);

    evidence.push(ev('dwell', `stopped ${Math.round(stop.dwellSec / 60)} min within ${stop.spreadM} m`, { dwellSec: stop.dwellSec }));
    if (stop.worstAccuracyM && stop.worstAccuracyM > cfg.warnAccuracyM) {
      evidence.push(ev('low_gps_accuracy', `worst fix accuracy ${Math.round(stop.worstAccuracyM)} m`));
    }

    // --- Modern Dairy facility -----------------------------------------
    if (facilityHits.length) {
      const hit = facilityHits[0];
      seg.type = SEGMENT_TYPE.MODERN_DAIRY_FACILITY_STOP;
      seg.confidence = CONFIDENCE.HIGH;
      seg.place = { id: hit.place.id, name: hit.place.name, kind: 'facility' };
      evidence.push(ev('facility_geofence', `${hit.place.name}: ${Math.round(hit.distanceM)} m inside a ${Math.round(hit.radiusM)} m geofence`));
      seg.evidence = evidence;
      seg.needsReview = false;
      seg.anchor = 'facility';
      continue;
    }

    // --- restaurant / known delivery location ---------------------------
    if (restaurantHits.length) {
      const hit = restaurantHits[0];
      const place = hit.place;
      seg.type = SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT;
      seg.place = { id: place.id, name: place.name, customerId: place.customerId || null, kind: 'restaurant' };
      evidence.push(ev('geofence_match', `${place.name}: ${Math.round(hit.distanceM)} m inside a ${Math.round(hit.radiusM)} m geofence`, { placeId: place.id }));

      const { support, otherDriver } = ordersSupporting(ctx.orders, place.customerId, ctx.driverId, seg.startTs, seg.endTs, cfg);

      if (restaurantHits.length > 1) {
        // Two geofences over one stop: a mall, a market lane, or radii set too
        // wide. We refuse to pick. A human decides.
        seg.confidence = CONFIDENCE.LOW;
        seg.needsReview = true;
        seg.ambiguousPlaces = restaurantHits.map((h) => ({ id: h.place.id, name: h.place.name, distanceM: Math.round(h.distanceM) }));
        evidence.push(ev('ambiguous_geofence', `${restaurantHits.length} known locations overlap this stop`, { places: seg.ambiguousPlaces }));
      } else if (support.length) {
        // A real order for this customer, in the window, for this driver. This
        // is the only path to HIGH confidence for a restaurant stop — and it
        // still does not assert that a delivery was completed.
        seg.confidence = CONFIDENCE.HIGH;
        seg.needsReview = false;
        evidence.push(ev('order_record', `${support.length} delivery order(s) for this customer in the time window`, { orderIds: support.map((o) => o.id) }));
      } else if (stop.dwellSec >= cfg.visitMinDwellSec) {
        seg.confidence = CONFIDENCE.MEDIUM;
        seg.needsReview = false;
        evidence.push(ev('no_order_data', 'no delivery order available to corroborate this visit'));
      } else {
        seg.confidence = CONFIDENCE.LOW;
        seg.needsReview = true;
        evidence.push(ev('short_dwell', `dwell ${stop.dwellSec}s is under the ${cfg.visitMinDwellSec}s visit threshold`));
      }

      if (otherDriver.length) {
        seg.needsReview = true;
        evidence.push(ev('order_assigned_elsewhere', `${otherDriver.length} order(s) here are assigned to another driver`, { orderIds: otherDriver.map((o) => o.id) }));
      }

      // A driver declaring a business-looking stop personal still wins — it
      // only ever removes kilometres from the business total — but the
      // conflict is flagged so a human sees it.
      if (declaration && declaration.kind === 'personal') {
        seg.type = SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS;
        seg.confidence = CONFIDENCE.MEDIUM;
        seg.needsReview = true;
        evidence.push(ev('driver_declared', `driver marked this period personal${declaration.note ? `: ${declaration.note}` : ''}`, { declaredAt: declaration.declaredAt }));
        evidence.push(ev('conflicting_evidence', 'driver declaration contradicts a geofence match — needs review'));
      }

      seg.evidence = evidence;
      seg.anchor = seg.type === SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT ? 'business' : 'personal';
      continue;
    }

    // --- nothing recognised ---------------------------------------------
    if (declaration && declaration.kind === 'personal') {
      seg.type = SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS;
      seg.confidence = CONFIDENCE.MEDIUM;
      seg.needsReview = false;
      seg.anchor = 'personal';
      evidence.push(ev('driver_declared', `driver marked this period personal${declaration.note ? `: ${declaration.note}` : ''}`, { declaredAt: declaration.declaredAt }));
    } else {
      seg.type = SEGMENT_TYPE.UNKNOWN;
      seg.confidence = CONFIDENCE.UNKNOWN;
      seg.needsReview = true;
      seg.anchor = 'unknown';
      evidence.push(ev('no_known_location', 'this stop is not inside any known Modern Dairy or customer geofence'));
    }
    // What was nearby, for the reviewer only. Proximity is context, never proof.
    const near = nearestPlaces(at, [...facilities, ...restaurants], 3)
      .map((n) => ({ id: n.place.id, name: n.place.name, distanceM: Math.round(n.distanceM) }));
    if (near.length) seg.nearbyPlaces = near;
    seg.evidence = evidence;
  }

  // ---- pass 2: travel --------------------------------------------------
  const prevStopOf = (i) => { for (let k = i - 1; k >= 0; k -= 1) if (out[k].kind === SEGMENT_KIND.STOP) return out[k]; return null; };
  const nextStopOf = (i) => { for (let k = i + 1; k < out.length; k += 1) if (out[k].kind === SEGMENT_KIND.STOP) return out[k]; return null; };

  for (let i = 0; i < out.length; i += 1) {
    const seg = out[i];
    if (seg.kind !== SEGMENT_KIND.TRAVEL) continue;
    const evidence = [];
    const before = prevStopOf(i);
    const after = nextStopOf(i);
    const declaration = declarationFor(ctx.declarations, seg.startTs, seg.endTs);

    // A leg made entirely of a tracking gap is not travel we observed.
    if (seg.distanceM === 0 && seg.gapEstimateM > 0) {
      seg.type = SEGMENT_TYPE.GPS_GAP_OR_INVALID_DATA;
      seg.confidence = CONFIDENCE.UNKNOWN;
      seg.needsReview = true;
      seg.evidence = [ev('tracking_gap', `${Math.round(seg.gapSeconds / 60)} min with no usable fix; ${Math.round(seg.gapEstimateM)} m straight-line estimate`)];
      continue;
    }

    const kindOf = (s) => {
      if (!s) return 'none';
      if (s.type === SEGMENT_TYPE.MODERN_DAIRY_FACILITY_STOP) return 'facility';
      if (s.type === SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT) return 'business';
      if (s.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS) return 'personal';
      return 'unknown';
    };
    // The open ends of the day: if the first fix is already inside a facility
    // the driver started there, and likewise for the last fix.
    const endpointPlace = (idx) => {
      if (idx == null || !points[idx]) return 'none';
      const p = points[idx];
      if (placesContaining(p, facilities, cfg.facilityRadiusM).length) return 'facility';
      if (placesContaining(p, restaurants.filter((r) => r.active !== false), cfg.geofenceDefaultRadiusM).length) return 'business';
      return 'none';
    };

    const a = before ? kindOf(before) : endpointPlace(seg.startIdx);
    const b = after ? kindOf(after) : endpointPlace(seg.endIdx);
    const confA = before ? before.confidence : (a === 'none' ? CONFIDENCE.UNKNOWN : CONFIDENCE.HIGH);
    const confB = after ? after.confidence : (b === 'none' ? CONFIDENCE.UNKNOWN : CONFIDENCE.HIGH);

    if (declaration && declaration.kind === 'personal') {
      seg.type = SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS;
      seg.confidence = CONFIDENCE.MEDIUM;
      seg.needsReview = false;
      evidence.push(ev('driver_declared', 'driver marked this period personal', { declaredAt: declaration.declaredAt }));
    } else if (a === 'facility' && (b === 'business' || b === 'facility')) {
      seg.type = SEGMENT_TYPE.MODERN_DAIRY_DEPARTURE;
      seg.confidence = weaker(confA, confB);
      evidence.push(ev('between_known_locations', `left a Modern Dairy facility heading to ${after ? (after.place?.name || 'a known location') : 'a known location'}`));
    } else if (b === 'facility' && (a === 'business' || a === 'facility')) {
      seg.type = SEGMENT_TYPE.RETURN_TO_MODERN_DAIRY;
      seg.confidence = weaker(confA, confB);
      evidence.push(ev('between_known_locations', 'returned to a Modern Dairy facility from a known business location'));
    } else if (a === 'business' && b === 'business') {
      seg.type = SEGMENT_TYPE.TRAVEL_BETWEEN_BUSINESS_LOCATIONS;
      seg.confidence = weaker(confA, confB);
      evidence.push(ev('between_known_locations', `travel between ${before.place?.name || 'a known location'} and ${after.place?.name || 'a known location'}`));
    } else if (a === 'personal' && b === 'personal') {
      seg.type = SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS;
      seg.confidence = CONFIDENCE.MEDIUM;
      evidence.push(ev('between_personal_stops', 'both ends of this leg are stops the driver declared personal'));
    } else {
      // One known end and one unknown end, or two unknown ends. This is the
      // honest answer and it is expected to be common before order data and
      // driver declarations are in use. It is NEVER folded into either total.
      seg.type = SEGMENT_TYPE.UNKNOWN;
      seg.confidence = a === 'none' && b === 'none' ? CONFIDENCE.UNKNOWN : CONFIDENCE.LOW;
      seg.needsReview = true;
      evidence.push(ev('unmatched_endpoints', `leg runs from ${a === 'none' ? 'an unrecognised position' : a} to ${b === 'none' ? 'an unrecognised position' : b}`));
    }

    if (seg.gapEstimateM > 0) {
      seg.needsReview = true;
      evidence.push(ev('partial_tracking_gap', `${Math.round(seg.gapSeconds / 60)} min gap inside this leg; ${Math.round(seg.gapEstimateM)} m is a straight-line estimate`));
    }
    if (seg.confidence === CONFIDENCE.LOW || seg.confidence === CONFIDENCE.UNKNOWN) seg.needsReview = true;
    seg.evidence = evidence;
  }

  // ---- pass 3: manual reviews -----------------------------------------
  // A review never rewrites history: the machine verdict stays on the segment
  // as originalType/originalConfidence and the decision is layered on top.
  for (const seg of out) {
    const review = (ctx.reviews || []).find((r) => r.segmentId === seg.id && !r.reverted);
    if (!review) { seg.needsReview = !!seg.needsReview; continue; }
    seg.originalType = seg.type;
    seg.originalConfidence = seg.confidence;
    seg.type = review.toType;
    seg.confidence = CONFIDENCE.HIGH;
    seg.needsReview = false;
    seg.reviewedBy = review.reviewerId;
    seg.reviewedAt = review.at;
    seg.evidence = [
      ...(seg.evidence || []),
      ev('admin_review', `reclassified from ${seg.originalType} by ${review.reviewerId}${review.note ? `: ${review.note}` : ''}`, { reviewId: review.id }),
    ];
  }

  return out;
}

module.exports = { SEGMENT_TYPE, CONFIDENCE, CONF_RANK, BUSINESS_TYPES, classifySegments, weaker };
