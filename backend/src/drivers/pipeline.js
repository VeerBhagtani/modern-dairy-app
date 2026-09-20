// The whole GPS → kilometres pipeline, as one pure function.
//
// No Firestore, no network, no Date.now(). Give it points and context, get back
// a complete, versioned result. That purity is what makes the numbers
// reproducible: the same raw points, the same config and the same context
// always produce byte-identical output, on a server or in a test, today or in
// two years when someone disputes a figure.

const { resolveConfig, CALC_VERSION } = require('./config');
const { cleanTrack, trackQuality } = require('./track');
const { detectStops } = require('./stops');
const { buildSegments } = require('./segmentation');
const { classifySegments, SEGMENT_TYPE, CONFIDENCE } = require('./classification');
const { summariseDistance, distancePerVisit } = require('./distance');
const { matchDeliveries } = require('./matching');

/**
 * @param {object} input
 *   points        raw GPS documents for the ride (any order)
 *   ride          { id, driverId, startedAt, stoppedAt, status }
 *   facilities    Modern Dairy sites
 *   restaurants   known delivery locations
 *   orders        delivery orders relevant to this ride's driver/day (may be [])
 *   declarations  driver "this is personal" declarations for this ride
 *   reviews       admin classification decisions for this ride
 *   configOverrides  drivers_config overrides
 *   nowMs         injected clock
 */
function processRideData(input) {
  const { config, rejected: rejectedConfig } = resolveConfig(input.configOverrides);
  const nowMs = input.nowMs;

  const track = cleanTrack(input.points || [], config, nowMs);
  const stops = detectStops(track.points, config);
  const { segments: rawSegments } = buildSegments(track.points, track.hops, stops);

  const ctx = {
    driverId: input.ride?.driverId || null,
    facilities: input.facilities || [],
    restaurants: input.restaurants || [],
    orders: input.orders || [],
    declarations: input.declarations || [],
    reviews: input.reviews || [],
  };
  const segments = classifySegments(rawSegments, track.points, ctx, config);
  const distance = summariseDistance(segments, track.totals);
  const visits = distancePerVisit(segments);
  const matching = matchDeliveries(segments, ctx.orders, ctx.restaurants, ctx, config);
  const quality = trackQuality(track.totals, config);

  const needsReview = segments.filter((s) => s.needsReview);

  return {
    calcVersion: CALC_VERSION,
    rideId: input.ride?.id || null,
    driverId: ctx.driverId,
    // The exact thresholds this result was produced with. Without this, an old
    // report cannot be explained after somebody retunes the config.
    configUsed: config,
    configRejected: rejectedConfig,

    track: {
      totals: track.totals,
      gaps: track.gaps,
      quality,
    },
    // Segments, stripped of the bulky internals the API does not need. The raw
    // points stay where they are; nothing here replaces them.
    segments: segments.map((s) => ({
      id: s.id,
      index: s.index,
      kind: s.kind,
      type: s.type,
      confidence: s.confidence,
      needsReview: !!s.needsReview,
      startTs: s.startTs,
      endTs: s.endTs,
      startIdx: s.startIdx,
      endIdx: s.endIdx,
      pointCount: s.pointCount,
      distanceM: Math.round(s.distanceM),
      gapEstimateM: Math.round(s.gapEstimateM),
      gapSeconds: s.gapSeconds,
      place: s.place || null,
      ambiguousPlaces: s.ambiguousPlaces || null,
      nearbyPlaces: s.nearbyPlaces || null,
      dwellSec: s.stop?.dwellSec ?? null,
      center: s.stop?.center ?? null,
      evidence: s.evidence || [],
      originalType: s.originalType || null,
      originalConfidence: s.originalConfidence || null,
      reviewedBy: s.reviewedBy || null,
      reviewedAt: s.reviewedAt || null,
    })),
    distance,
    visits,
    matching,
    review: {
      pending: needsReview.length,
      segmentIds: needsReview.map((s) => s.id),
      unknownKm: distance.km.unknown,
    },
    counts: {
      points: track.totals.rawCount,
      usablePoints: track.totals.acceptedCount,
      stops: stops.length,
      segments: segments.length,
      restaurantVisits: visits.length,
      facilityStops: segments.filter((s) => s.type === SEGMENT_TYPE.MODERN_DAIRY_FACILITY_STOP).length,
      personalSegments: segments.filter((s) => s.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS).length,
      unknownSegments: segments.filter((s) => s.type === SEGMENT_TYPE.UNKNOWN).length,
    },
  };
}

// Roll several ride results into one period figure (week, month, custom range).
// Kilometres are re-derived from the metre totals rather than summed from
// rounded kilometres, so a month of 0.1 km roundings cannot drift.
function aggregateRides(results) {
  const m = { verifiedBusiness: 0, likelyBusiness: 0, personal: 0, unknown: 0, invalid: 0, gapEstimate: 0, measured: 0, dayTotal: 0 };
  let visits = 0, matched = 0, unmatchedVisits = 0, unmatchedOrders = 0, pendingReview = 0, rides = 0;
  const perDriver = new Map();
  const perPlace = new Map();

  for (const r of results) {
    rides += 1;
    for (const k of Object.keys(m)) m[k] += r.distance.metres[k];
    visits += r.counts.restaurantVisits;
    matched += r.matching.summary.matched;
    unmatchedVisits += r.matching.summary.unmatchedVisits;
    unmatchedOrders += r.matching.summary.unmatchedOrders;
    pendingReview += r.review.pending;

    const d = perDriver.get(r.driverId) || { driverId: r.driverId, rides: 0, verifiedBusinessM: 0, likelyBusinessM: 0, personalM: 0, unknownM: 0, dayTotalM: 0, visits: 0 };
    d.rides += 1;
    d.verifiedBusinessM += r.distance.metres.verifiedBusiness;
    d.likelyBusinessM += r.distance.metres.likelyBusiness;
    d.personalM += r.distance.metres.personal;
    d.unknownM += r.distance.metres.unknown;
    d.dayTotalM += r.distance.metres.dayTotal;
    d.visits += r.counts.restaurantVisits;
    perDriver.set(r.driverId, d);

    for (const v of r.visits) {
      if (!v.placeId) continue;
      const p = perPlace.get(v.placeId) || { placeId: v.placeId, placeName: v.placeName, customerId: v.customerId, visits: 0, approachM: 0 };
      p.visits += 1;
      p.approachM += v.approachDistanceM;
      perPlace.set(v.placeId, p);
    }
  }

  const km = (x) => Math.round((x / 1000) * 10) / 10;
  return {
    rides,
    metres: { ...m },
    km: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, km(v)])),
    visits,
    matched,
    unmatchedVisits,
    unmatchedOrders,
    pendingReview,
    averageKmPerVisit: visits ? Math.round((m.verifiedBusiness + m.likelyBusiness) / visits / 100) / 10 : 0,
    perDriver: [...perDriver.values()].map((d) => ({ ...d, km: { verifiedBusiness: km(d.verifiedBusinessM), likelyBusiness: km(d.likelyBusinessM), personal: km(d.personalM), unknown: km(d.unknownM), dayTotal: km(d.dayTotalM) } })),
    perPlace: [...perPlace.values()].map((p) => ({ ...p, approachKm: km(p.approachM) })),
  };
}

module.exports = { processRideData, aggregateRides, SEGMENT_TYPE, CONFIDENCE };
