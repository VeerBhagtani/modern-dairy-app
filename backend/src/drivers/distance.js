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

  return {
    // Metres, for maths. Kilometres, for humans — at one decimal, which is the
    // honest resolution of a GPS-derived distance.
    metres: {
      verifiedBusiness: Math.round(m.verifiedBusinessM),
      likelyBusiness: Math.round(m.likelyBusinessM),
      personal: Math.round(m.personalM),
      unknown: Math.round(m.unknownM),
      invalid: Math.round(m.invalidM),
      gapEstimate: Math.round(m.gapEstimateM),
      measured: Math.round(measuredM),
      dayTotal: Math.round(dayTotalM),
    },
    km: {
      verifiedBusiness: toKm(m.verifiedBusinessM),
      likelyBusiness: toKm(m.likelyBusinessM),
      personal: toKm(m.personalM),
      unknown: toKm(m.unknownM),
      invalid: toKm(m.invalidM),
      gapEstimate: toKm(m.gapEstimateM),
      measured: toKm(measuredM),
      dayTotal: toKm(dayTotalM),
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

// Per-visit distance: the travel that led to each restaurant visit. Attributed
// to the visit that FOLLOWS the leg, and each leg is used once, so the per-visit
// figures can be summed without double-counting.
function distancePerVisit(segments) {
  const visits = [];
  let pending = 0;
  let pendingGap = 0;
  for (const seg of segments) {
    if (seg.kind === 'travel') { pending += seg.distanceM; pendingGap += seg.gapEstimateM; continue; }
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

module.exports = { BUCKET, bucketFor, summariseDistance, distancePerVisit };
