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

/* Was the vehicle parked, or crawling in traffic?
 *
 * Inside a stop the fixes of a parked phone scatter around one point (GPS
 * noise, indoor wander) with no direction. In a jam or a slow queue the
 * vehicle inches forward: the fixes drift steadily one way. Measured as the
 * distance from where the stop's first quarter of fixes sat to where its last
 * quarter sat, and how many steps went forward along that line. A long red
 * light with no movement at all looks parked: that is said, not guessed.
 */
const CRAWL_MIN_DRIFT_M = 25;
const CRAWL_MIN_FORWARD = 0.6;
function motionOf(all) {
  const out = { driftM: 0, forward: 0, pattern: 'still' };
  // Only the middle of the stop: the fixes of arriving and leaving fall
  // inside the radius too, and would look like steady movement. Fixes at
  // driving speed are left out for the same reason.
  const t0 = all[0].deviceTs; const t1 = all[all.length - 1].deviceTs;
  const edge = (t1 - t0) * 0.15;
  const c = all.filter((p) => p.deviceTs >= t0 + edge && p.deviceTs <= t1 - edge
    && !(Number.isFinite(p.speedMps) && p.speedMps > 3));
  if (c.length < 4) return out;
  const q = Math.max(1, Math.floor(c.length / 4));
  const a = centroid(c.slice(0, q));
  const b = centroid(c.slice(-q));
  const drift = haversineM(a, b);
  // Forward steps: each fix a little further from the start than the last.
  let fwd = 0; let steps = 0;
  for (let i = 1; i < c.length; i += 1) {
    const d0 = haversineM(a, c[i - 1]); const d1 = haversineM(a, c[i]);
    if (Math.abs(d1 - d0) < 1) continue;   // standing still: neither way
    steps += 1;
    if (d1 > d0) fwd += 1;
  }
  const accs = c.map((p) => p.accuracyM).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  const medAcc = accs.length ? accs[Math.floor(accs.length / 2)] : 10;
  out.driftM = Math.round(drift);
  out.forward = steps ? Math.round((fwd / steps) * 100) / 100 : 0;
  if (drift >= Math.max(CRAWL_MIN_DRIFT_M, 1.5 * medAcc) && out.forward >= CRAWL_MIN_FORWARD) out.pattern = 'crawl';
  return out;
}

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
      // 'crawl' = kept inching forward (traffic); 'still' = did not move.
      motion: motionOf(c),
    };
  });
}

module.exports = { detectStops, motionOf, CRAWL_MIN_DRIFT_M };
