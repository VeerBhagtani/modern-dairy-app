/* The route replay, as the calculation saw it.
 *
 * The replay map used to draw the raw GPS as one line, with the excluded fixes
 * taken from the processing document. That list is capped (to keep the document
 * under Firestore's size limit), so on a bad-GPS day anything past the cap was
 * drawn as road: spikes to the other side of Pune, counted nowhere, shown as if
 * driven. And a silence in the GPS was drawn as a straight road.
 *
 * This re-runs the same track cleaning the kilometres came from (uncapped, and
 * pure, so it gives the same verdicts) and labels every point:
 *   used   whether it counted towards the distance
 *   q      why not, when it did not
 *   b      what the stretch ending at this point counted as —
 *          business | personal | unknown | gap
 * plus the GPS gaps, so the map can draw a silence as a silence.
 */
'use strict';

const { cleanTrack } = require('../drivers/track');
const { bucketFor, BUCKET } = require('../drivers/distance');

const KIND = {
  [BUCKET.VERIFIED_BUSINESS]: 'business',
  [BUCKET.LIKELY_BUSINESS]: 'business',
  [BUCKET.PERSONAL]: 'personal',
  [BUCKET.UNKNOWN]: 'unknown',
  [BUCKET.INVALID]: 'gap',
};

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/* The segment a hop from prevTs to ts belongs to, by the same rule the
 * calculation uses: inside one segment, that segment; across two, the travel
 * one. Found by time, so a point uploaded after the calculation still lands
 * somewhere sensible. */
function segmentFor(segments, prevTs, ts) {
  let inside = null;
  let travel = null;
  let any = null;
  for (const s of segments) {
    if (s.startTs == null || s.endTs == null) continue;
    if (s.startTs > ts || s.endTs < prevTs) continue;   // no overlap with the hop
    if (s.startTs <= prevTs && s.endTs >= ts && (!inside || s.kind === 'travel')) inside = s;
    if (s.kind === 'travel' && !travel) travel = s;
    any = s;
  }
  return inside || travel || any;
}

/**
 * @param points      raw points of the ride
 * @param processing  the saved calculation (segments, configUsed, processedAt)
 * @returns {{ points: Array, gaps: Array, calculated: boolean }}
 */
function buildReplay(points, processing) {
  if (!processing || !processing.configUsed) {
    // Not calculated yet: show the raw track, undecided, with nothing excluded.
    const sorted = [...(points || [])].sort((a, b) => a.deviceTs - b.deviceTs);
    return {
      calculated: false,
      gaps: [],
      points: sorted.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p) => ({ lat: round6(p.lat), lng: round6(p.lng), ts: p.deviceTs, used: true, b: 'unknown' })),
    };
  }
  const track = cleanTrack(points || [], processing.configUsed, processing.processedAt || Date.now());
  const segments = processing.segments || [];
  const out = [];
  let prev = null;
  for (const p of track.points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const row = { lat: round6(p.lat), lng: round6(p.lng), ts: p.deviceTs, used: !!p.countDistance };
    if (!p.countDistance) {
      row.q = p.quality;
    } else {
      const seg = segmentFor(segments, prev ? prev.deviceTs : p.deviceTs, p.deviceTs);
      row.b = seg ? (KIND[bucketFor(seg)] || 'unknown') : 'unknown';
      prev = p;
    }
    out.push(row);
  }
  return {
    calculated: true,
    gaps: track.gaps.map((g) => ({ fromTs: g.fromTs, toTs: g.toTs, seconds: g.seconds, straightLineM: Math.round(g.straightLineM) })),
    points: out,
  };
}

module.exports = { buildReplay, segmentFor };
