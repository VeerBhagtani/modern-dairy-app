// Segment classification.
//
// This is the file that decides what Modern Dairy pays for, so every verdict
// it produces carries the evidence that produced it. The dashboard shows that
// evidence next to the verdict, because a kilometre figure a manager cannot
// explain to a driver is worse than no figure at all.
//
// The rules below, as the office set them:
//
//  1. Business and personal are decided by the restaurants. Driving TO a
//     restaurant is business, and so is driving between restaurants and the
//     depot. Driving that does not lead to a restaurant — after the last one of
//     the day, to and from places that are not customers, a commute to the
//     depot — is personal. (This replaced an earlier rule that geometry could
//     never call anything personal, which left most of every day "unknown".)
//  2. Nothing becomes BUSINESS because it is NEAR a known place. It must be
//     inside the configured geofence. A restaurant stop that is doubtful — two
//     geofences overlapping, or too short to be a visit — does not make its
//     legs business or personal: they stay UNKNOWN until somebody reviews them.
//  3. A driver's personal declaration and an office review always win.
//  4. A restaurant visit is never evidence that a delivery happened. That is a
//     separate engine (matching.js) with a separate verdict field.
//
// Personal-by-rule distance whose far end is close to a known customer is
// flagged for review: the likeliest reason is a restaurant pinned in the wrong
// place, and that would otherwise quietly move a real delivery run out of
// business.

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

// How close to a known place an unrecognised stop has to be before its
// personal verdict is flagged for a human: a few geofences' worth.
const NEAR_KNOWN_PLACE_M = 250;

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
      // Not a restaurant and not the depot: by the restaurant rule, not
      // business.
      seg.type = SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS;
      seg.confidence = CONFIDENCE.MEDIUM;
      seg.needsReview = false;
      seg.anchor = 'personal';
      evidence.push(ev('no_known_location', 'this stop is not inside any restaurant or Modern Dairy geofence'));
    }
    // What was nearby, for the reviewer only. Proximity is context, never proof.
    const near = nearestPlaces(at, [...facilities, ...restaurants], 3)
      .map((n) => ({ id: n.place.id, name: n.place.name, distanceM: Math.round(n.distanceM) }));
    if (near.length) seg.nearbyPlaces = near;
    // A stop just outside a customer's geofence is the classic sign of a pin in
    // the wrong place. Personal by rule, but a human should look.
    if (!declaration && near.length && near[0].distanceM <= NEAR_KNOWN_PLACE_M) {
      seg.needsReview = true;
      evidence.push(ev('near_known_place', `${near[0].name} is ${near[0].distanceM} m away — check its location on the map`));
    }
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

    // A restaurant stop is only a firm anchor when the visit itself is not in
    // doubt. Two overlapping geofences, or a stop too short to be a visit,
    // leave the legs either side UNKNOWN for review rather than deciding them.
    const doubtful = (s) => !!s && s.type === SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT && s.confidence === CONFIDENCE.LOW;
    const isWork = (k) => k === 'business' || k === 'facility';
    const placeName = (s, fallback) => (s && s.place && s.place.name) || fallback;
    const firmA = !doubtful(before);

    if (declaration && declaration.kind === 'personal') {
      seg.type = SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS;
      seg.confidence = CONFIDENCE.MEDIUM;
      seg.needsReview = false;
      evidence.push(ev('driver_declared', 'driver marked this period personal', { declaredAt: declaration.declaredAt }));
    } else if ((b === 'business' && doubtful(after)) || (b === 'facility' && a === 'business' && !firmA)) {
      seg.type = SEGMENT_TYPE.UNKNOWN;
      seg.confidence = CONFIDENCE.LOW;
      seg.needsReview = true;
      evidence.push(ev('doubtful_visit', 'the restaurant stop at one end is uncertain (overlapping geofences or too short to be a visit) — review it to decide this leg'));
    } else if (a === 'facility' && isWork(b)) {
      seg.type = SEGMENT_TYPE.MODERN_DAIRY_DEPARTURE;
      seg.confidence = weaker(confA, confB);
      evidence.push(ev('between_known_locations', `left a Modern Dairy facility heading to ${placeName(after, 'a known location')}`));
    } else if (b === 'facility' && a === 'business' && firmA) {
      seg.type = SEGMENT_TYPE.RETURN_TO_MODERN_DAIRY;
      seg.confidence = weaker(confA, confB);
      evidence.push(ev('between_known_locations', 'returned to a Modern Dairy facility from a restaurant'));
    } else if (a === 'business' && firmA && b === 'business') {
      seg.type = SEGMENT_TYPE.TRAVEL_BETWEEN_BUSINESS_LOCATIONS;
      seg.confidence = weaker(confA, confB);
      evidence.push(ev('between_known_locations', `travel between ${placeName(before, 'a restaurant')} and ${placeName(after, 'a restaurant')}`));
    } else if (b === 'business') {
      // Driving to a restaurant is business, wherever it started from. Never
      // stronger than MEDIUM: where the trip began is not known to be work.
      seg.type = SEGMENT_TYPE.BUSINESS_TRAVEL;
      seg.confidence = weaker(confB, CONFIDENCE.MEDIUM);
      evidence.push(ev('to_restaurant', `travel to ${placeName(after, 'a restaurant')}`));
    } else {
      // Not heading to a restaurant: after the last restaurant, between places
      // that are not customers, or to the depot from elsewhere (a commute).
      seg.type = SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS;
      seg.confidence = CONFIDENCE.MEDIUM;
      seg.needsReview = false;
      const from = a === 'business' ? `leaving ${placeName(before, 'a restaurant')}`
        : a === 'facility' ? 'leaving the depot' : 'from a place that is not a restaurant';
      const to = b === 'facility' ? 'to the depot' : 'not to a restaurant';
      evidence.push(ev('no_restaurant_destination', `${from}, ${to}`));
      // Ending next to a customer that is not recognised: most likely a pin in
      // the wrong place, and a real delivery run about to be called personal.
      if (after && after.nearbyPlaces && after.nearbyPlaces[0] && after.nearbyPlaces[0].distanceM <= NEAR_KNOWN_PLACE_M) {
        seg.needsReview = true;
        evidence.push(ev('near_known_place', `ends ${after.nearbyPlaces[0].distanceM} m from ${after.nearbyPlaces[0].name} — check its location on the map`));
      }
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
  //
  // Segment ids are POSITIONAL (seg_0007), so a reprocess that changes the
  // segmentation — a threshold edit, or late points arriving from a phone that
  // was offline — could otherwise silently re-attach a decision to a different
  // stretch of road. Each review therefore carries the time window it was made
  // against, and a review whose window no longer matches is NOT applied: the
  // segment goes back for review with the mismatch on the record.
  const REVIEW_WINDOW_TOLERANCE_MS = 60000;
  for (const seg of out) {
    const review = (ctx.reviews || []).find((r) => r.segmentId === seg.id && !r.reverted);
    if (!review) { seg.needsReview = !!seg.needsReview; continue; }

    const pinned = Number.isFinite(review.segStartTs);
    const moved = pinned && (
      Math.abs((seg.startTs ?? 0) - review.segStartTs) > REVIEW_WINDOW_TOLERANCE_MS
      || (Number.isFinite(review.segEndTs) && Math.abs((seg.endTs ?? 0) - review.segEndTs) > REVIEW_WINDOW_TOLERANCE_MS)
    );
    if (moved) {
      seg.needsReview = true;
      seg.staleReviewId = review.id || null;
      seg.evidence = [
        ...(seg.evidence || []),
        ev('stale_review', `an earlier decision (${review.toType} by ${review.reviewerId}) was made against a different time window for this segment id and has NOT been applied — please review again`, { reviewId: review.id || null }),
      ];
      continue;
    }

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
