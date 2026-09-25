// Track cleaning and distance measurement.
//
// Input: the raw point list exactly as stored. Output: an ordered, de-duplicated
// view of it plus the hop-by-hop distance, WITHOUT modifying or discarding a
// single raw point. Everything rejected is still present in `points`, carrying
// the reason it was rejected, because the replay map and the reliability report
// both have to show what was thrown away.
//
// Distance is produced as a list of HOPS rather than a single number. That is
// what lets segmentation attribute every metre to exactly one segment, which
// is what makes double-counting structurally impossible instead of merely
// unlikely.

const { haversineM } = require('./geo');
const { QUALITY, classifyPointQuality } = require('./validation');

// How a distance number was arrived at. Reported alongside every total,
// because "we measured this" and "we guessed this" must never look alike.
const METHOD = {
  MEASURED: 'measured',     // dense GPS, hop by hop
  ESTIMATED: 'estimated',   // straight line across a tracking gap
  INFERRED: 'inferred',     // derived from other numbers (e.g. per-order split)
};

// Deterministic ordering: device time, then the client point id. The id
// tie-break matters — without it, two points sharing a millisecond would sort
// differently on different runs and the output would not be reproducible.
function sortPoints(points) {
  return [...points].sort((a, b) => (
    a.deviceTs - b.deviceTs || String(a.clientPointId).localeCompare(String(b.clientPointId))
  ));
}

/**
 * @param {Array} rawPoints stored points (any order)
 * @param {object} cfg resolved config
 * @param {number} nowMs clock, injected so the function stays pure/testable
 * @returns {{
 *   points: Array,   every input point, ordered, annotated with quality
 *   hops: Array,     [{ fromIdx, toIdx, distanceM, dtSec, method, acrossGap }]
 *   gaps: Array,     [{ fromIdx, toIdx, seconds, straightLineM, fromTs, toTs }]
 *   totals: object,  measuredM, gapEstimateM, counts by reason
 * }}
 */
function cleanTrack(rawPoints, cfg, nowMs) {
  const ordered = sortPoints(rawPoints || []);

  const points = [];
  const hops = [];
  const gaps = [];
  const byReason = Object.create(null);
  const seenIds = new Set();

  let measuredM = 0;
  let gapEstimateM = 0;
  let jitterM = 0;          // movement below minMoveM, deliberately not counted
  let prevAccepted = null;
  let prevAcceptedIdx = -1;

  for (const raw of ordered) {
    const idx = points.length;

    // Same clientPointId twice: an upload was replayed. The second copy is
    // recorded as a duplicate rather than silently vanishing, so the sync
    // health report can show that retries are happening.
    if (seenIds.has(raw.clientPointId)) {
      byReason[QUALITY.DUPLICATE] = (byReason[QUALITY.DUPLICATE] || 0) + 1;
      points.push({ ...raw, idx, quality: QUALITY.DUPLICATE, countDistance: false });
      continue;
    }
    seenIds.add(raw.clientPointId);

    const verdict = classifyPointQuality(raw, prevAccepted, cfg, nowMs);
    const p = {
      ...raw,
      idx,
      quality: verdict.quality,
      countDistance: verdict.countDistance,
      qualityDetail: verdict.detail || null,
    };
    points.push(p);

    if (!verdict.countDistance) {
      byReason[verdict.quality] = (byReason[verdict.quality] || 0) + 1;
      continue;
    }
    if (verdict.quality === QUALITY.LOW_ACCURACY) {
      byReason[QUALITY.LOW_ACCURACY] = (byReason[QUALITY.LOW_ACCURACY] || 0) + 1;
    }

    if (prevAccepted) {
      const dtSec = (p.deviceTs - prevAccepted.deviceTs) / 1000;
      const distM = haversineM(prevAccepted, p);
      const acrossGap = dtSec > cfg.gapSeconds;

      if (acrossGap) {
        // The driver certainly travelled something during the silence. Calling
        // it zero is as wrong as calling the straight line the real route, so
        // it goes in its own bucket, labelled as an estimate, and is never
        // added to the measured total.
        gaps.push({
          fromIdx: prevAcceptedIdx,
          toIdx: idx,
          seconds: Math.round(dtSec),
          straightLineM: distM,
          fromTs: prevAccepted.deviceTs,
          toTs: p.deviceTs,
        });
        gapEstimateM += distM;
        hops.push({ fromIdx: prevAcceptedIdx, toIdx: idx, distanceM: distM, dtSec, method: METHOD.ESTIMATED, acrossGap: true });
      } else if (distM < cfg.minMoveM) {
        // Jitter while parked. Counted nowhere, but tallied so a reviewer can
        // see how much noise the filter absorbed.
        jitterM += distM;
        hops.push({ fromIdx: prevAcceptedIdx, toIdx: idx, distanceM: 0, dtSec, method: METHOD.MEASURED, acrossGap: false, jitterM: distM });
      } else {
        measuredM += distM;
        hops.push({ fromIdx: prevAcceptedIdx, toIdx: idx, distanceM: distM, dtSec, method: METHOD.MEASURED, acrossGap: false });
      }
    }

    prevAccepted = p;
    prevAcceptedIdx = idx;
  }

  const acceptedCount = points.filter((p) => p.countDistance).length;
  const firstTs = points.length ? points[0].deviceTs : null;
  const lastTs = points.length ? points[points.length - 1].deviceTs : null;

  return {
    points,
    hops,
    gaps,
    totals: {
      rawCount: points.length,
      acceptedCount,
      rejectedCount: points.length - acceptedCount,
      byReason,
      measuredM,
      gapEstimateM,
      jitterM,
      // The day total is measured + the gap estimate. Both halves are always
      // reported; a consumer that wants only what was actually observed uses
      // measuredM alone.
      totalM: measuredM + gapEstimateM,
      firstTs,
      lastTs,
      durationSec: firstTs != null && lastTs != null ? Math.round((lastTs - firstTs) / 1000) : 0,
      gapCount: gaps.length,
      gapSecondsTotal: gaps.reduce((s, g) => s + g.seconds, 0),
    },
  };
}

// Overall data-quality grade for the reliability report. Deliberately coarse:
// a three-way split a dispatcher can act on beats a score nobody can interpret.
function trackQuality(totals, cfg) {
  if (!totals.rawCount) return { grade: 'no_data', reasons: ['no points recorded'] };
  const reasons = [];
  const rejectRatio = totals.rejectedCount / totals.rawCount;
  const lowAcc = (totals.byReason.low_accuracy || 0) / totals.rawCount;

  if (rejectRatio > 0.2) reasons.push(`${Math.round(rejectRatio * 100)}% of fixes were unusable`);
  if (lowAcc > 0.3) reasons.push(`${Math.round(lowAcc * 100)}% of fixes were low accuracy`);
  if (totals.gapSecondsTotal > 3600) reasons.push(`${Math.round(totals.gapSecondsTotal / 60)} minutes of tracking gaps`);
  if (totals.byReason.implausible_jump) reasons.push(`${totals.byReason.implausible_jump} implausible position jumps`);
  if (totals.byReason.mock_location) reasons.push(`${totals.byReason.mock_location} mock-location fixes`);

  // Expected point count from the sampling interval; well under it means the
  // OS was killing the service, which is the single most common failure here.
  const expected = totals.durationSec > 0 ? totals.durationSec / cfg.sampleIntervalSec : 0;
  const coverage = expected > 0 ? totals.acceptedCount / expected : 1;
  if (coverage < 0.5) reasons.push(`only ${Math.round(coverage * 100)}% of expected fixes arrived`);

  let grade = 'good';
  if (reasons.length >= 3 || coverage < 0.35 || rejectRatio > 0.4) grade = 'poor';
  else if (reasons.length) grade = 'fair';
  return { grade, reasons, coverage: Math.round(coverage * 100) / 100 };
}

/* Movement while parked is not travel.
 *
 * A stop is, by definition, at least stopMinDwellSec within stopRadiusM of one
 * spot. A phone lying on a dashboard for twenty minutes still wanders a few
 * metres at a time, and hops over minMoveM added up to hundreds of "measured"
 * metres at every restaurant. A hop that starts and ends inside the same stop
 * is moved to the jitter tally instead. Hops leaving or entering a stop are
 * untouched: that is the drive.
 *
 * Mutates the hops (which the caller owns) and returns new totals, so the
 * reconciliation checks against the same figure the segments add up to.
 */
function absorbStopJitter(track, stops) {
  if (!stops.length) return track.totals;
  const stopOf = new Map();
  stops.forEach((st, k) => { for (let i = st.startIdx; i <= st.endIdx; i += 1) stopOf.set(i, k); });
  let moved = 0;
  for (const hop of track.hops) {
    if (hop.acrossGap || hop.distanceM === 0) continue;
    const a = stopOf.get(hop.fromIdx);
    if (a === undefined || a !== stopOf.get(hop.toIdx)) continue;
    moved += hop.distanceM;
    hop.jitterM = (hop.jitterM || 0) + hop.distanceM;
    hop.distanceM = 0;
    hop.parked = true;
  }
  if (!moved) return track.totals;
  const t = track.totals;
  return { ...t, measuredM: t.measuredM - moved, jitterM: t.jitterM + moved, parkedJitterM: moved, totalM: t.totalM - moved };
}

module.exports = { METHOD, cleanTrack, trackQuality, sortPoints, absorbStopJitter };
