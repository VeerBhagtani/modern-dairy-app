// Modern Drivers — processing thresholds.
//
// Every number that changes what the system CONCLUDES lives here, with the
// range it is allowed to take and a note on what breaks if you move it. The
// defaults are documented guesses tuned for dense-city Pune driving on
// consumer Android phones; they are not physical constants and they are not
// sacred. Treat any change as a change to the reported kilometres: the
// resolved config is stamped onto every processing result, so an old report
// can always be explained by the thresholds that produced it.
//
// Overrides live in Firestore at drivers_config/singleton and are audit-logged.

const DEFAULTS = {
  // ---- point validation ----------------------------------------------
  // Fixes worse than this are excluded from distance. 200 m is deliberately
  // generous: Android reports poor accuracy indoors and at loading docks, and
  // throwing those away entirely would delete real stops. Lower it and you
  // lose genuine travel; raise it and noise becomes kilometres.
  rejectAccuracyM: 200,
  // Accuracy above this is kept but marked low-quality in the health report.
  warnAccuracyM: 50,
  // ~120 km/h. Anything faster between two consecutive fixes in city traffic
  // is a GPS teleport, not a vehicle. Raise it if the fleet ever runs on
  // expressways; a bike in Pune traffic will never approach it.
  maxSpeedMps: 33,
  // How far a device clock may run ahead of the server before the point is
  // rejected as clock-skewed. Phones drift; phones are also set by hand.
  clockSkewMin: 30,

  // ---- track cleaning -------------------------------------------------
  // Movement below this between fixes is treated as jitter while parked and
  // contributes zero distance. Without it a phone sitting at a restaurant for
  // 20 minutes invents several hundred metres. Too high and slow crawling
  // traffic stops being counted.
  minMoveM: 12,
  // A silence longer than this is a tracking GAP, not travel. Distance across
  // it is reported separately as a straight-line ESTIMATE, never as measured.
  gapSeconds: 300,

  // ---- stop detection -------------------------------------------------
  // A stop is points staying within this radius of their running centroid...
  stopRadiusM: 60,
  // ...for at least this long. The same 2 minutes as a restaurant visit: a
  // quick drop that did not register as a stop could never become a visit.
  // A stop this short that is not at a restaurant or the depot is a pause on
  // the way (see transitStopMaxSec), so traffic does not split a trip.
  stopMinDwellSec: 120,
  // An unrecognised stop (no restaurant, not the depot, not declared) shorter
  // than this is a pause on the way — a jam, a signal, fuel — not a
  // destination: the trip either side is judged by where it was going. Longer,
  // and it is a place the driver went to, which by the restaurant rule is not
  // business.
  transitStopMaxSec: 600,

  // ---- geofencing -----------------------------------------------------
  // Fallback radius for a restaurant with no radiusM of its own.
  geofenceDefaultRadiusM: 80,
  // Modern Dairy sites are large (yard, loading bay, parking).
  facilityRadiusM: 150,
  // A geofenced stop shorter than this cannot reach MEDIUM confidence: being
  // parked outside a restaurant for 40 seconds is not evidence of a visit.
  visitMinDwellSec: 120,

  // ---- delivery matching ----------------------------------------------
  // How far a stop centroid may sit from the order's expected location.
  matchRadiusM: 150,
  // How far outside an order's delivery window a visit may fall and still be
  // a POSSIBLE match. Inside the window it is a MATCH.
  matchTimeToleranceMin: 120,

  // ---- ride lifecycle -------------------------------------------------
  // A ride nobody stopped is auto-closed after this many hours, recorded as
  // status 'auto_closed' with the threshold that closed it. Never silent.
  autoStopAfterHours: 16,
  // Position older than this is NOT live. The dashboard must say "stale".
  staleLocationSec: 180,
  // No GPS at all for this long during an active ride raises an alert.
  gpsMissingAlertMin: 15,
  // A ride running longer than this raises a "still active" alert (before the
  // hard auto-stop above).
  longRideAlertHours: 12,

  // ---- upload ---------------------------------------------------------
  // Max points the driver app may send in one batch.
  maxBatchPoints: 200,
  // Interval the app is told to sample at. Lower = more accurate distance and
  // more battery and more Firestore writes. 30 s ≈ 1,440 points/driver/day.
  sampleIntervalSec: 30,

  // ---- retention (days) -----------------------------------------------
  retention: {
    // Raw points are deleted after this, and only once the ride has processed
    // results, so reports stay auditable after the point cloud is gone.
    rawGpsDays: 180,
    // Segments, distances, matches.
    processedDays: 1095,
    // Health/anomaly events.
    trackingEventDays: 365,
    // Audit, reviews and alerts are NOT auto-deleted; deleting them would
    // defeat their purpose. Listed here so the omission is deliberate.
  },
};

// Allowed ranges. An override outside its range is ignored and reported, not
// clamped silently — a typo that makes every stop a "visit" should be loud.
const RANGES = {
  rejectAccuracyM: [10, 2000],
  warnAccuracyM: [5, 500],
  maxSpeedMps: [10, 100],
  clockSkewMin: [1, 720],
  minMoveM: [0, 100],
  gapSeconds: [60, 7200],
  stopRadiusM: [10, 500],
  stopMinDwellSec: [30, 7200],
  transitStopMaxSec: [0, 7200],
  geofenceDefaultRadiusM: [20, 2000],
  facilityRadiusM: [20, 5000],
  visitMinDwellSec: [0, 7200],
  matchRadiusM: [20, 5000],
  matchTimeToleranceMin: [0, 1440],
  autoStopAfterHours: [1, 48],
  staleLocationSec: [30, 86400],
  gpsMissingAlertMin: [1, 1440],
  longRideAlertHours: [1, 48],
  maxBatchPoints: [1, 1000],
  sampleIntervalSec: [5, 600],
};

// Bumped whenever a change here or in the pipeline can change a reported
// number. Stored on every ride_processing document so results are traceable
// and so a recalculation can be triggered for everything below a version.
const CALC_VERSION = '1.2.0';

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// Merge overrides over the defaults. Returns { config, rejected[] } — rejected
// carries every override that was out of range or of the wrong type, so the
// caller can surface it instead of the system quietly using a default.
function resolveConfig(overrides) {
  const config = clone(DEFAULTS);
  const rejected = [];
  if (!overrides || typeof overrides !== 'object') return { config, rejected };

  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'retention') {
      if (!value || typeof value !== 'object') { rejected.push({ key, reason: 'not an object' }); continue; }
      for (const [rk, rv] of Object.entries(value)) {
        if (!(rk in config.retention)) { rejected.push({ key: `retention.${rk}`, reason: 'unknown key' }); continue; }
        if (!Number.isFinite(rv) || rv < 1 || rv > 3650) { rejected.push({ key: `retention.${rk}`, reason: 'out of range 1..3650' }); continue; }
        config.retention[rk] = rv;
      }
      continue;
    }
    if (!(key in config)) { rejected.push({ key, reason: 'unknown key' }); continue; }
    const range = RANGES[key];
    if (!Number.isFinite(value)) { rejected.push({ key, reason: 'not a finite number' }); continue; }
    if (range && (value < range[0] || value > range[1])) {
      rejected.push({ key, reason: `out of range ${range[0]}..${range[1]}` });
      continue;
    }
    config[key] = value;
  }
  return { config, rejected };
}

module.exports = { DEFAULTS, RANGES, CALC_VERSION, resolveConfig };
