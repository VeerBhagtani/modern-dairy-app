// Stop detection by dwell clustering.
//
// A "stop" is a run of consecutive usable fixes that stay within stopRadiusM of
// their running centroid for at least stopMinDwellSec. That is deliberately
// simple and deliberately explainable: a manager in a payroll dispute can be
// told "the phone did not move more than 60 metres for 3 minutes" and check it
// on the replay map. A clustering algorithm with tuned hyper-parameters could
// not be defended the same way.
//
// What it does NOT do: decide what the stop MEANS. A stop is a physical fact.
// Whether it was a delivery, a tea break or a traffic jam is classification's
// problem, and mostly it is the honest answer "we cannot tell".

const { haversineM, centroid } = require('./geo');

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return Math.round(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2);
}

/**
 * @param {Array} points annotated points from cleanTrack (all of them)
 * @param {object} cfg resolved config
 * @returns {Array} stops, ordered, non-overlapping
 */
function detectStops(points, cfg) {
  // Only fixes good enough to be believed take part. A 300 m-accuracy fix
  // could place the driver anywhere in the block and would smear a stop.
  const usable = points.filter((p) => p.countDistance);
  if (usable.length < 2) return [];

  // 1. Runs of fixes within stopRadiusM of their running centroid.
  const runs = [];
  let cluster = [usable[0]];
  let center = { lat: usable[0].lat, lng: usable[0].lng };
  const close = () => {
    if (cluster.length < 2) return;
    const dwellSec = (cluster[cluster.length - 1].deviceTs - cluster[0].deviceTs) / 1000;
    if (dwellSec >= cfg.stopMinDwellSec) runs.push(cluster);
  };
  for (let i = 1; i < usable.length; i += 1) {
    const p = usable[i];
    if (haversineM(center, p) <= cfg.stopRadiusM) {
      cluster.push(p);
      center = centroid(cluster);
      continue;
    }
    close();
    cluster = [p];
    center = { lat: p.lat, lng: p.lng };
  }
  close();

  // 2. One parked phone, not two stops. Indoors a phone wanders: a fix or two
  // drifts past the radius and the dwell splits in two with a short "drive"
  // between that never happened. Two stops at the same spot (centres within
  // stopRadiusM) are one stop when, between them, the phone never got further
  // than twice the radius, for no longer than transitStopMaxSec. Anything that
  // left that circle was a real drive and keeps the stops apart.
  const merged = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && !cfg.legacyCleaning) {   // (not when replaying a result made before 1.6.0)
      const a = centroid(prev); const b = centroid(run);
      const awaySec = (run[0].deviceTs - prev[prev.length - 1].deviceTs) / 1000;
      const between = usable.filter((p) => p.deviceTs > prev[prev.length - 1].deviceTs && p.deviceTs < run[0].deviceTs);
      if (haversineM(a, b) <= cfg.stopRadiusM && awaySec <= (cfg.transitStopMaxSec || 600)
          && between.every((p) => haversineM(a, p) <= 2 * cfg.stopRadiusM)) {
        merged[merged.length - 1] = [...prev, ...between, ...run];
        continue;
      }
    }
    merged.push(run);
  }

  return merged.map((c) => {
    const ctr = centroid(c);
    return {
      startIdx: c[0].idx,
      endIdx: c[c.length - 1].idx,
      startTs: c[0].deviceTs,
      endTs: c[c.length - 1].deviceTs,
      dwellSec: Math.round((c[c.length - 1].deviceTs - c[0].deviceTs) / 1000),
      center: ctr,
      pointCount: c.length,
      // How tightly the fixes sat. A wide spread on a long dwell usually means
      // poor urban GPS rather than movement, and the reviewer should see it.
      spreadM: Math.round(Math.max(...c.map((p) => haversineM(ctr, p)))),
      // Worst accuracy in the cluster — the honest bound on "where was this".
      worstAccuracyM: c.reduce((m, p) => Math.max(m, p.accuracyM || 0), 0) || null,
      // Typical accuracy: whether the fixes could place the stop inside a
      // geofence at all.
      medianAccuracyM: median(c.map((p) => p.accuracyM).filter((a) => Number.isFinite(a))),
    };
  });
}

module.exports = { detectStops };
