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

/**
 * @param {Array} points annotated points from cleanTrack (all of them)
 * @param {object} cfg resolved config
 * @returns {Array} stops, ordered, non-overlapping
 */
function detectStops(points, cfg) {
  // Only fixes good enough to be believed take part. A 300 m-accuracy fix
  // could place the driver anywhere in the block and would smear a stop.
  const usable = points.filter((p) => p.countDistance);
  const stops = [];
  if (usable.length < 2) return stops;

  let cluster = [usable[0]];
  let center = { lat: usable[0].lat, lng: usable[0].lng };

  const close = () => {
    if (cluster.length < 2) return;
    const dwellSec = (cluster[cluster.length - 1].deviceTs - cluster[0].deviceTs) / 1000;
    if (dwellSec < cfg.stopMinDwellSec) return;
    const c = centroid(cluster);
    stops.push({
      startIdx: cluster[0].idx,
      endIdx: cluster[cluster.length - 1].idx,
      startTs: cluster[0].deviceTs,
      endTs: cluster[cluster.length - 1].deviceTs,
      dwellSec: Math.round(dwellSec),
      center: c,
      pointCount: cluster.length,
      // How tightly the fixes sat. A wide spread on a long dwell usually means
      // poor urban GPS rather than movement, and the reviewer should see it.
      spreadM: Math.round(Math.max(...cluster.map((p) => haversineM(c, p)))),
      // Worst accuracy in the cluster — the honest bound on "where was this".
      worstAccuracyM: cluster.reduce((m, p) => Math.max(m, p.accuracyM || 0), 0) || null,
    });
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

  return stops;
}

module.exports = { detectStops };
