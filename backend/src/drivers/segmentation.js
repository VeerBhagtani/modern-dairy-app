// Turns a cleaned track plus detected stops into an ordered segment list.
//
// The invariant this file exists to guarantee:
//
//   * every point index belongs to exactly one segment, and
//   * every hop's distance is attributed to exactly one segment.
//
// Those two facts are what make double-counting impossible by construction
// rather than by careful coding. They are asserted in the test suite over
// randomly generated tracks, not just the happy path.

const SEGMENT_KIND = { TRAVEL: 'travel', STOP: 'stop' };

/**
 * @param {Array} points annotated points from cleanTrack (ALL of them, in order)
 * @param {Array} hops   hops from cleanTrack
 * @param {Array} stops  stops from detectStops
 * @returns {{ segments: Array, ownership: Int32Array }}
 */
function buildSegments(points, hops, stops) {
  const segments = [];
  if (!points.length) return { segments, pointSegment: [] };

  const pointSegment = new Array(points.length).fill(-1);

  const pushSegment = (kind, startIdx, endIdx, stop) => {
    const empty = startIdx > endIdx;
    const seg = {
      index: segments.length,
      id: `seg_${String(segments.length).padStart(4, '0')}`,
      kind,
      startIdx: empty ? null : startIdx,
      endIdx: empty ? null : endIdx,
      pointCount: empty ? 0 : endIdx - startIdx + 1,
      // A boundary-only segment: two stops with no usable fix between them.
      // It still exists because the hop joining them has to belong somewhere.
      boundaryOnly: empty,
      startTs: empty ? null : points[startIdx].deviceTs,
      endTs: empty ? null : points[endIdx].deviceTs,
      distanceM: 0,
      gapEstimateM: 0,
      gapSeconds: 0,
      hopCount: 0,
      methods: new Set(),
      stop: stop || null,
    };
    if (!empty) for (let i = startIdx; i <= endIdx; i += 1) pointSegment[i] = seg.index;
    segments.push(seg);
    return seg;
  };

  const ordered = [...stops].sort((a, b) => a.startIdx - b.startIdx);
  let cursor = 0;
  for (const stop of ordered) {
    // Travel leading up to this stop (may be boundary-only).
    pushSegment(SEGMENT_KIND.TRAVEL, cursor, stop.startIdx - 1, null);
    pushSegment(SEGMENT_KIND.STOP, stop.startIdx, stop.endIdx, stop);
    cursor = stop.endIdx + 1;
  }
  // Whatever is left after the last stop, including the case of no stops at
  // all (a driver who never parked long enough: one long travel segment).
  pushSegment(SEGMENT_KIND.TRAVEL, cursor, points.length - 1, null);

  // ---- hop attribution -------------------------------------------------
  // Rule: a hop between two different segments belongs to the TRAVEL one. A
  // boundary-only travel segment between two stops wins over both. Within one
  // segment, it belongs to that segment. Every hop lands in exactly one place.
  for (const hop of hops) {
    const a = pointSegment[hop.fromIdx];
    const b = pointSegment[hop.toIdx];
    let owner;
    if (a === b) {
      owner = a;
    } else {
      const between = [];
      for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i += 1) {
        if (segments[i].boundaryOnly) between.push(i);
      }
      if (between.length) owner = between[0];
      else if (segments[b].kind === SEGMENT_KIND.TRAVEL) owner = b;
      else if (segments[a].kind === SEGMENT_KIND.TRAVEL) owner = a;
      else owner = b;
    }
    const seg = segments[owner];
    seg.hopCount += 1;
    seg.methods.add(hop.method);
    if (hop.acrossGap) {
      seg.gapEstimateM += hop.distanceM;
      seg.gapSeconds += Math.round(hop.dtSec);
    } else {
      seg.distanceM += hop.distanceM;
    }
    // A boundary-only segment has no points, so give it the timestamps of the
    // hop that created it — otherwise it would have no position in time.
    if (seg.boundaryOnly) {
      seg.startTs = seg.startTs ?? points[hop.fromIdx].deviceTs;
      seg.endTs = points[hop.toIdx].deviceTs;
    }
  }

  // Drop boundary-only segments that ended up owning nothing at all: they
  // would be noise in the UI and they carry no distance by definition.
  const kept = segments.filter((s) => !(s.boundaryOnly && s.hopCount === 0));
  kept.forEach((s, i) => {
    s.index = i;
    s.id = `seg_${String(i).padStart(4, '0')}`;
    s.methods = [...s.methods];
  });
  // pointSegment held the pre-filter indices; rebuild it against the kept list.
  const remap = new Map(kept.map((s, i) => [s, i]));
  const rebuilt = new Array(points.length).fill(-1);
  for (const seg of kept) {
    if (seg.startIdx == null) continue;
    for (let i = seg.startIdx; i <= seg.endIdx; i += 1) rebuilt[i] = remap.get(seg);
  }

  return { segments: kept, pointSegment: rebuilt };
}

module.exports = { SEGMENT_KIND, buildSegments };
