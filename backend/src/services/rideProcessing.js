/* Calculating a ride, for everyone who needs it calculated.
 *
 * This used to live in routes/admin.js, reachable only from the office. The
 * drivers' own history on their phones needs the same numbers, calculated the
 * same way, so it lives here and both route files use it.
 */
'use strict';

const repo = require('./repo');
const freshness = require('./freshness');
const { processRideData } = require('../drivers/pipeline');
const { evaluateResultAlerts } = require('../drivers/alerts');
const legObservations = require('../drivers/legObservations');
const { autoCloseStaleRides } = require('../jobs/maintenance');

const busy = () => Object.assign(new Error('This ride is being calculated right now.'), { code: 'BUSY' });

// Re-run the whole calculation for one ride. Safe to call any number of times:
// it reads the immutable raw points and REPLACES the processed result, so a
// threshold change or a new review is picked up without touching the GPS data.
//
// waitMs: how long to wait for another calculation of the same ride to finish.
// Zero for background refreshes — somebody else is already doing the work.
// Longer where a person is waiting on this exact result: a review, a stop.
async function processOne(rideId, { waitMs = 0 } = {}) {
  const until = Date.now() + waitMs;
  let token = await repo.acquireCalcLease(rideId);
  while (!token && Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
    // eslint-disable-next-line no-await-in-loop
    token = await repo.acquireCalcLease(rideId);
  }
  if (!token) {
    // Either another calculation holds the ride, or the ride does not exist.
    const exists = await repo.getRide(rideId);
    if (!exists) throw Object.assign(new Error('Ride not found'), { code: 'NO_RIDE' });
    throw busy();
  }
  try {
    return await calculate(rideId);
  } finally {
    await repo.releaseCalcLease(rideId, token).catch(() => {});
  }
}

async function calculate(rideId) {
  const ride = await repo.getRide(rideId);
  if (!ride) throw Object.assign(new Error('Ride not found'), { code: 'NO_RIDE' });
  // The retention job deletes raw GPS only from rides that already have a
  // result. Calculating one of those again would read no points and replace a
  // real day's kilometres with zeros, permanently.
  if (ride.rawGpsDeletedAt) {
    throw Object.assign(new Error('The raw GPS for this ride was deleted under the retention policy; its stored result is final.'), { code: 'NO_RAW' });
  }

  const inputsAt = Date.now();
  const [{ config, overrides }, points, places, orders, declarations, reviews] = await Promise.all([
    repo.getConfig(),
    repo.loadPoints(rideId),
    repo.loadPlaces(),
    repo.ordersForRide(ride),
    repo.declarationsForRide(rideId),
    repo.reviewsForRide(rideId),
  ]);
  const result = processRideData({
    points,
    ride: { id: rideId, driverId: ride.driverId, startedAt: ride.startedAt, stoppedAt: ride.stoppedAt },
    facilities: places.facilities,
    restaurants: places.restaurants,
    orders,
    declarations,
    reviews: reviews.filter((r) => !r.reverted && !r.superseded),
    configOverrides: overrides,
    nowMs: Date.now(),
  });
  await repo.saveProcessing(rideId, result, { inputsAt });

  // Learn this driver's roads from the ride. Every leg between two restaurants
  // they actually drove is a measurement of how far apart those two places are
  // FOR THEM — which is what the trip planner uses instead of asking a map
  // that does not know their shortcuts.
  //
  // Never allowed to fail the calculation: the kilometre figures are the
  // point, and a routing convenience must not endanger them.
  try {
    const { observations, sequence } = legObservations.legsFromVisits(result.visits);
    if (observations.length || sequence.length >= 2) {
      // The ride id is what lets a recalculation replace this ride's
      // observations instead of appending a second copy.
      await repo.recordDriverLegs(ride.driverId, observations, sequence, { rideId });
      repo.invalidateFleetLegs();
    }
  } catch (e) {
    await repo.writeEvent({
      driverId: ride.driverId,
      rideId,
      kind: 'leg_learning_failed',
      detail: { error: String(e.message || e).slice(0, 200) },
    }).catch(() => {});
  }

  // Alerts about a ride's RESULT — orders not delivered, segments needing
  // review, big tracking gaps — describe a finished day. Raised from a ride
  // still running, they fire at ten in the morning about deliveries nobody has
  // reached yet, and re-fire on every recalculation. So they wait for the end.
  if (ride.status !== 'active') {
    const existing = await repo.openAlerts({ driverId: ride.driverId });
    const desired = evaluateResultAlerts(ride, result, config);
    await repo.applyAlertDiff({
      toRaise: desired,
      // Only result-derived alerts are reconciled here; live-tracking alerts
      // have their own lifecycle in the maintenance job.
      toResolve: existing.filter((a) => a.rideId === rideId && ['large_gap', 'unmatched_delivery', 'segment_needs_review'].includes(a.kind) && !desired.some((d) => d.key === a.key)),
    });
  }
  return result;
}

/* Housekeeping nobody has to remember: rides over the configured length are
 * closed, and rides whose day has ended are closed at the end of that day.
 * Throttled; see freshness.makeHousekeeper. */
const housekeeping = freshness.makeHousekeeper(async (nowMs) => {
  const { config } = await repo.getConfig();
  const dayClosed = [];
  for (const ride of await repo.activeRides()) {
    // eslint-disable-next-line no-await-in-loop
    const closed = await repo.closeIfDayOver(ride, nowMs);
    if (closed) dayClosed.push(closed.id);
  }
  const timedOut = await autoCloseStaleRides(config, nowMs);
  return { dayClosed, timedOut };
});

/* Calculate what is out of date among these rides, within a budget. */
function bringUpToDate(rides, opts) {
  return freshness.keepCurrent(rides, { processOne, markFailed: repo.markCalcFailed }, opts);
}

module.exports = { processOne, bringUpToDate, housekeeping };
