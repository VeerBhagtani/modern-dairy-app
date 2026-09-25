// Distance bucketing and reconciliation.
//
// The output of this file is the number Modern Dairy acts on, so it is built to
// be checkable rather than merely plausible:
//
//   verified + likely + personal + unknown + invalid  = measured
//   measured + gapEstimate                            = day total
//
// Both identities are asserted here and the residual is REPORTED, never
// rounded away. If the two sides ever disagree the API says so out loud.

const { SEGMENT_TYPE, CONFIDENCE, BUSINESS_TYPES } = require('./classification');
const { toKm } = require('./geo');
const { METHOD } = require('./track');

const BUCKET = {
  VERIFIED_BUSINESS: 'verifiedBusiness',
  LIKELY_BUSINESS: 'likelyBusiness',
  PERSONAL: 'personal',
  UNKNOWN: 'unknown',
  INVALID: 'invalid',
};

// Which bucket a classified segment's MEASURED distance belongs to.
// Only HIGH confidence reaches the verified business total. That single line is
// the difference between a number the company can defend and a guess.
function bucketFor(seg) {
  if (seg.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS) return BUCKET.PERSONAL;
  if (seg.type === SEGMENT_TYPE.GPS_GAP_OR_INVALID_DATA) return BUCKET.INVALID;
  if (BUSINESS_TYPES.has(seg.type)) {
    if (seg.confidence === CONFIDENCE.HIGH) return BUCKET.VERIFIED_BUSINESS;
    if (seg.confidence === CONFIDENCE.MEDIUM) return BUCKET.LIKELY_BUSINESS;
    return BUCKET.UNKNOWN;   // LOW / UNKNOWN business-looking distance is NOT business
  }
  return BUCKET.UNKNOWN;
}

/**
 * @param {Array} segments classified segments
 * @param {object} totals cleanTrack totals (for cross-checking)
 */
function summariseDistance(segments, totals) {
  const m = {
    verifiedBusinessM: 0,
    likelyBusinessM: 0,
    personalM: 0,
    unknownM: 0,
    invalidM: 0,
    gapEstimateM: 0,
  };
  const perSegment = [];

  for (const seg of segments) {
    const bucket = bucketFor(seg);
    const key = `${bucket}M`;
    m[key] += seg.distanceM;
    // Gap distance never lands in a business bucket, whatever the segment is
    // classified as: it was not observed, so it cannot be verified.
    m.gapEstimateM += seg.gapEstimateM;
    perSegment.push({
      segmentId: seg.id,
      bucket,
      measuredM: Math.round(seg.distanceM),
      gapEstimateM: Math.round(seg.gapEstimateM),
      method: seg.gapEstimateM > 0 && seg.distanceM > 0 ? 'mixed'
        : seg.gapEstimateM > 0 ? METHOD.ESTIMATED : METHOD.MEASURED,
    });
  }

  const measuredM = m.verifiedBusinessM + m.likelyBusinessM + m.personalM + m.unknownM + m.invalidM;
  const dayTotalM = measuredM + m.gapEstimateM;

  // Sub-metre float noise is fine; anything above 1 m means a real bug in
  // segment/hop attribution, and it must be visible rather than swallowed.
  const bucketResidualM = measuredM - (totals ? totals.measuredM : measuredM);
  const totalResidualM = dayTotalM - (totals ? totals.totalM : dayTotalM);

  // Rounded so the parts always add up to the rounded whole, exactly, in both
  // metres and kilometres (largest remainder). Rounding each bucket on its
  // own made 3.04 + 3.04 + 3.04 display as 9.0 against a total of 9.1, which
  // looks like lost distance. The real residual, before any rounding, is in
  // reconciliation below and is never adjusted.
  const parts = { verifiedBusiness: m.verifiedBusinessM, likelyBusiness: m.likelyBusinessM, personal: m.personalM, unknown: m.unknownM, invalid: m.invalidM };
  const metresParts = apportion(parts, 1);
  const kmParts = apportion(parts, 100);   // units of 100 m = 0.1 km
  return {
    // Metres, for maths. Kilometres, for humans — at one decimal, which is the
    // honest resolution of a GPS-derived distance.
    metres: {
      ...metresParts,
      gapEstimate: Math.round(m.gapEstimateM),
      measured: Object.values(metresParts).reduce((a, b) => a + b, 0),
      dayTotal: Object.values(metresParts).reduce((a, b) => a + b, 0) + Math.round(m.gapEstimateM),
    },
    km: {
      ...Object.fromEntries(Object.entries(kmParts).map(([k, v]) => [k, v / 10])),
      gapEstimate: toKm(m.gapEstimateM),
      measured: Object.values(kmParts).reduce((a, b) => a + b, 0) / 10,
      dayTotal: (Object.values(kmParts).reduce((a, b) => a + b, 0) + Math.round(m.gapEstimateM / 100)) / 10,
    },
    perSegment,
    reconciliation: {
      ok: Math.abs(bucketResidualM) < 1 && Math.abs(totalResidualM) < 1,
      bucketResidualM: Math.round(bucketResidualM * 100) / 100,
      totalResidualM: Math.round(totalResidualM * 100) / 100,
      explanation: 'verified + likely + personal + unknown + invalid = measured; measured + gapEstimate = day total. A non-zero residual is a bug in segment attribution and is reported rather than hidden.',
    },
    methodNote: 'Measured distance is the sum of great-circle hops between consecutive usable GPS fixes; it under-reads on curved roads. Gap distance is a straight-line estimate across tracking silences and is never counted as business travel.',
  };
}

/* Round a set of parts to whole units of `unit` metres so that they sum to
 * the rounded total (largest-remainder method). Deterministic: ties go to the
 * earlier key. */
function apportion(parts, unit) {
  const keys = Object.keys(parts);
  const exact = keys.map((k) => parts[k] / unit);
  const total = Math.round(exact.reduce((a, b) => a + b, 0));
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; floors[i] += 1; left -= 1; }
  return Object.fromEntries(keys.map((k, i) => [k, floors[i]]));
}

// Per-visit distance: the travel that led to each restaurant visit. Attributed
// to the visit that FOLLOWS the leg, and each leg is used once, so the per-visit
// figures can be summed without double-counting.
function distancePerVisit(segments) {
  const visits = [];
  let pending = 0;
  let pendingGap = 0;
  for (const seg of segments) {
    // A pause on the way is part of the approach, not the end of it.
    if (seg.kind === 'travel' || seg.transit) { pending += seg.distanceM; pendingGap += seg.gapEstimateM; continue; }
    if (seg.type === SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT) {
      visits.push({
        segmentId: seg.id,
        placeId: seg.place?.id || null,
        placeName: seg.place?.name || null,
        customerId: seg.place?.customerId || null,
        arrivedAt: seg.startTs,
        departedAt: seg.endTs,
        dwellSec: seg.stop?.dwellSec ?? null,
        confidence: seg.confidence,
        approachDistanceM: Math.round(pending),
        approachGapEstimateM: Math.round(pendingGap),
        approachMethod: pendingGap > 0 ? 'mixed' : METHOD.MEASURED,
      });
    }
    pending = 0;
    pendingGap = 0;
  }
  return visits;
}

/* The ride as legs: from one place the driver actually stopped at to the
 * next — Depot → A, A → B, B → C, C → Depot — each with its own distance,
 * split by bucket, and the evidence of what each end was. Pauses on the way
 * belong to the leg they interrupted. The first leg starts at the first fix
 * and the last ends at the last one.
 *
 * Reconciles by construction: the legs' measured metres plus what was
 * measured while stopped at the places themselves equal the ride's measured
 * total, and that identity is returned so it can be checked.
 */
function routeLegs(segments, points) {
  const isAnchor = (s) => s.kind === 'stop' && !s.transit;
  const endOf = (s) => (s ? {
    kind: s.type === 'MODERN_DAIRY_FACILITY_STOP' ? 'depot' : s.type === 'LIKELY_RESTAURANT_VISIT' ? 'restaurant' : (s.place ? 'restaurant' : 'other'),
    placeId: s.place ? s.place.id : null,
    name: s.place ? s.place.name : 'a place that is not a customer',
    at: s.startTs, leftAt: s.endTs, segmentId: s.id,
  } : null);
  const legs = [];
  let cur = null;
  let atStopsM = 0;
  const open = (from, ts) => ({ from, to: null, startTs: ts, endTs: ts, measuredM: 0, gapEstimateM: 0, byBucket: {}, segmentIds: [] });
  const firstTs = points && points.length ? points[0].deviceTs : null;
  cur = open({ kind: 'start', placeId: null, name: 'Ride start', at: firstTs }, firstTs);
  for (const seg of segments) {
    if (isAnchor(seg)) {
      atStopsM += seg.distanceM;
      cur.to = endOf(seg);
      cur.endTs = seg.startTs;
      if (cur.measuredM > 0 || cur.gapEstimateM > 0 || cur.segmentIds.length) legs.push(cur);
      cur = open(endOf(seg), seg.endTs);
      continue;
    }
    const b = bucketFor(seg);
    cur.measuredM += seg.distanceM;
    cur.gapEstimateM += seg.gapEstimateM;
    cur.byBucket[b] = (cur.byBucket[b] || 0) + seg.distanceM;
    cur.segmentIds.push(seg.id);
    if (seg.endTs != null) cur.endTs = seg.endTs;
  }
  if (cur.segmentIds.length) {
    cur.to = { kind: 'end', placeId: null, name: 'Ride end', at: cur.endTs };
    legs.push(cur);
  }
  const round = (l) => ({
    ...l,
    measuredM: Math.round(l.measuredM),
    gapEstimateM: Math.round(l.gapEstimateM),
    byBucket: Object.fromEntries(Object.entries(l.byBucket).map(([k, v]) => [k, Math.round(v)])),
    // What the leg counted as, for a one-word summary: the bucket holding
    // most of its distance.
    mainly: Object.entries(l.byBucket).sort((x, y) => y[1] - x[1])[0]?.[0] || null,
  });
  const legsM = legs.reduce((a, l) => a + l.measuredM, 0);
  const measuredM = segments.reduce((a, s) => a + s.distanceM, 0);
  return {
    legs: legs.map(round),
    check: {
      legsM: Math.round(legsM),
      atStopsM: Math.round(atStopsM),
      measuredM: Math.round(measuredM),
      residualM: Math.round((legsM + atStopsM - measuredM) * 100) / 100,
    },
  };
}

module.exports = { BUCKET, bucketFor, summariseDistance, distancePerVisit, apportion, routeLegs };
