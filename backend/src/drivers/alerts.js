// Operational alerts.
//
// Pure evaluation: given the current state of a ride, return the alerts that
// SHOULD exist right now. The caller diffs that against the alerts that DO
// exist and writes only the difference — which is what stops a dispatcher's
// screen filling with the same "GPS is stale" line every minute.
//
// Alerts deliberately carry no coordinates. A dispatcher needs to know a
// driver's tracking has failed; an alert row (which may be emailed, pushed, or
// read over someone's shoulder) does not need to say where they are.

const ALERT = {
  GPS_MISSING: 'gps_missing',
  LOCATION_STALE: 'location_stale',
  RIDE_TOO_LONG: 'ride_too_long',
  LARGE_GAP: 'large_gap',
  UNMATCHED_DELIVERY: 'unmatched_delivery',
  NEEDS_REVIEW: 'segment_needs_review',
  UNAUTHORIZED_RIDE_CONTROL: 'unauthorized_ride_control',
  PERMISSION_LOST: 'tracking_permission_lost',
};

const SEVERITY = { INFO: 'info', WARN: 'warn', CRITICAL: 'critical' };

// A stable key per (kind, subject). Two evaluations of the same condition
// produce the same key, so "already raised" is a lookup, not a guess.
const keyFor = (kind, driverId, extra) => [kind, driverId, extra || ''].join('|');

/**
 * @param {object} ride  { id, driverId, status, startedAt, lastPointAt }
 * @param {object} cfg
 * @param {number} nowMs
 */
function evaluateRideAlerts(ride, cfg, nowMs) {
  const out = [];
  if (!ride || ride.status !== 'active') return out;

  const sinceLastPoint = ride.lastPointAt ? (nowMs - ride.lastPointAt) / 1000 : (nowMs - ride.startedAt) / 1000;

  if (sinceLastPoint > cfg.gpsMissingAlertMin * 60) {
    out.push({
      key: keyFor(ALERT.GPS_MISSING, ride.driverId),
      kind: ALERT.GPS_MISSING,
      severity: sinceLastPoint > cfg.gpsMissingAlertMin * 180 ? SEVERITY.CRITICAL : SEVERITY.WARN,
      driverId: ride.driverId,
      rideId: ride.id,
      detail: `No GPS for ${Math.round(sinceLastPoint / 60)} minutes on an active ride.`,
    });
  } else if (sinceLastPoint > cfg.staleLocationSec) {
    out.push({
      key: keyFor(ALERT.LOCATION_STALE, ride.driverId),
      kind: ALERT.LOCATION_STALE,
      severity: SEVERITY.INFO,
      driverId: ride.driverId,
      rideId: ride.id,
      detail: `Last position is ${Math.round(sinceLastPoint / 60)} minutes old.`,
    });
  }

  const hours = (nowMs - ride.startedAt) / 3600000;
  if (hours > cfg.longRideAlertHours) {
    out.push({
      key: keyFor(ALERT.RIDE_TOO_LONG, ride.driverId, ride.id),
      kind: ALERT.RIDE_TOO_LONG,
      severity: hours > cfg.autoStopAfterHours - 1 ? SEVERITY.WARN : SEVERITY.INFO,
      driverId: ride.driverId,
      rideId: ride.id,
      detail: `Ride has been active for ${hours.toFixed(1)} h. It will auto-close at ${cfg.autoStopAfterHours} h unless an admin stops it.`,
    });
  }
  return out;
}

// Alerts derived from a finished ride's processing result.
function evaluateResultAlerts(ride, result, cfg) {
  const out = [];
  const bigGap = result.track.gaps.find((g) => g.seconds > cfg.gapSeconds * 4);
  if (bigGap) {
    out.push({
      key: keyFor(ALERT.LARGE_GAP, ride.driverId, ride.id),
      kind: ALERT.LARGE_GAP, severity: SEVERITY.WARN, driverId: ride.driverId, rideId: ride.id,
      detail: `${Math.round(bigGap.seconds / 60)} minute tracking gap; ${Math.round(bigGap.straightLineM)} m of travel could only be estimated.`,
    });
  }
  if (result.matching.summary.unmatchedOrders > 0) {
    out.push({
      key: keyFor(ALERT.UNMATCHED_DELIVERY, ride.driverId, ride.id),
      kind: ALERT.UNMATCHED_DELIVERY, severity: SEVERITY.INFO, driverId: ride.driverId, rideId: ride.id,
      detail: `${result.matching.summary.unmatchedOrders} delivery order(s) have no matching visit.`,
    });
  }
  if (result.review.pending > 0) {
    out.push({
      key: keyFor(ALERT.NEEDS_REVIEW, ride.driverId, ride.id),
      kind: ALERT.NEEDS_REVIEW, severity: SEVERITY.INFO, driverId: ride.driverId, rideId: ride.id,
      detail: `${result.review.pending} segment(s) and ${result.review.unknownKm} km need review before the business total is final.`,
    });
  }
  return out;
}

// Only write what changed. Returns { toRaise, toResolve }.
function diffAlerts(desired, existingOpen) {
  const desiredKeys = new Set(desired.map((a) => a.key));
  const openKeys = new Set(existingOpen.map((a) => a.key));
  return {
    toRaise: desired.filter((a) => !openKeys.has(a.key)),
    toResolve: existingOpen.filter((a) => !desiredKeys.has(a.key)),
  };
}

module.exports = { ALERT, SEVERITY, keyFor, evaluateRideAlerts, evaluateResultAlerts, diffAlerts };
