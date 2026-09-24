/* Keep the kilometres current, without a scheduler.
 *
 * Distance is worked out by processing a ride's raw GPS points, and until this
 * existed nothing did that on its own. A ride was calculated only when
 * somebody pressed "Calculate now" or ran maintenance by hand — and
 * maintenance skipped every ride still running. Only the office can stop a
 * ride, so rides ran all day, and all week, uncalculated: the dashboard showed
 * nothing for drivers whose phones had sent thousands of points. A ride
 * calculated once, early, kept its first near-empty answer for good.
 *
 * There is no scheduler to hang this on (Cloud Run is idle between requests,
 * and a background timer there is not reliable), so the work is done when
 * somebody looks: the dashboard, a ride, a report. That is also exactly when a
 * fresh number is needed.
 *
 *   - a ride with points and no result is calculated;
 *   - a finished ride whose points arrived after its last calculation is
 *     recalculated;
 *   - a running ride is recalculated once new points have arrived and its
 *     last result is at least FRESH_MS old — often enough for a live total,
 *     rarely enough that a dashboard refreshing every few seconds does not
 *     re-read a whole day of points each time.
 *
 * And the 16-hour automatic close-out, which also lived only inside the
 * manual maintenance run, happens here too, so a ride nobody stopped ends and
 * the next morning starts a new one instead of piling days into one ride.
 *
 * Bounded per request by count and by time, so opening the dashboard never
 * waits on a whole backlog; whatever is left is picked up next time.
 */
'use strict';

const FRESH_MS = 5 * 60 * 1000;
const HOUSEKEEPING_EVERY_MS = 10 * 60 * 1000;
// A ride whose calculation failed is retried after this, or sooner if new
// points arrive — not on every look.
const RETRY_FAILED_MS = 30 * 60 * 1000;

function needsCalc(ride, nowMs, { freshMs = FRESH_MS } = {}) {
  if (!ride || !ride.pointCount) return false;                  // nothing to calculate from
  // Raw GPS removed under the retention policy: the stored result is final.
  // Recalculating would read no points and overwrite it with zeros.
  if (ride.rawGpsDeletedAt) return false;
  if (ride.calcFailedAt && nowMs - ride.calcFailedAt < RETRY_FAILED_MS
      && (ride.lastUploadAt || 0) <= ride.calcFailedAt) return false;
  if (!ride.processedAt) return true;
  // What the last result saw: the moment it read the points. The save time is
  // later, and a batch uploaded in between would otherwise never be counted.
  const seen = ride.processedInputsAt || ride.processedAt;
  // A review, revert or declaration since the last result: recalculate now,
  // whatever the ride's state — the office is waiting to see its decision.
  if ((ride.inputsChangedAt || 0) > seen) return true;
  const newPoints = (ride.lastUploadAt || 0) > seen;
  if (!newPoints) return false;
  if (ride.status === 'active') return nowMs - ride.processedAt >= freshMs;
  return true;
}

/* @param rides   ride rows (with id, status, pointCount, processedAt, lastUploadAt)
 * @param deps    { processOne(rideId), markFailed(rideId, message)?, now() }
 * @param opts    { maxRides, budgetMs, freshMs }
 * @returns { calculated: [rideId], failed: [{rideId,error}], deferred: n }
 *
 * Oldest-calculated first, so a backlog is worked through fairly rather than
 * the same few rides being refreshed while others wait.
 */
async function keepCurrent(rides, deps, { maxRides = 10, budgetMs = 8000, freshMs = FRESH_MS } = {}) {
  const now = deps.now ? deps.now() : Date.now();
  // Rides that have failed before go last: sorted only by age they would lead
  // every queue (they never get a result), and a handful of broken rides would
  // use up the whole budget on every look while the rest waited.
  const due = rides
    .filter((r) => needsCalc(r, now, { freshMs }))
    .sort((a, b) => (a.calcFailedAt ? 1 : 0) - (b.calcFailedAt ? 1 : 0)
      || (a.processedAt || 0) - (b.processedAt || 0));
  const calculated = []; const failed = []; let busy = 0;
  const started = deps.now ? deps.now() : Date.now();
  for (const ride of due) {
    if (calculated.length + failed.length >= maxRides) break;
    if ((deps.now ? deps.now() : Date.now()) - started > budgetMs) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      await deps.processOne(ride.id);
      calculated.push(ride.id);
    } catch (e) {
      // Another request is calculating this ride right now: not a failure,
      // and its result will be there in a moment.
      if (e && e.code === 'BUSY') { busy += 1; continue; }
      // One ride's failure must not stop the rest, or the dashboard.
      const message = String((e && e.message) || e).slice(0, 200);
      failed.push({ rideId: ride.id, error: message });
      if (deps.markFailed) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve(deps.markFailed(ride.id, message)).catch(() => {});
      }
    }
  }
  return { calculated, failed, busy, deferred: due.length - calculated.length - failed.length - busy };
}

/* Throttled so every dashboard refresh does not re-scan active rides. */
function makeHousekeeper(run, { everyMs = HOUSEKEEPING_EVERY_MS } = {}) {
  let last = 0;
  return async function housekeeping(nowMs = Date.now()) {
    if (nowMs - last < everyMs) return null;
    last = nowMs;
    try { return await run(nowMs); } catch (e) { return { error: String((e && e.message) || e) }; }
  };
}

module.exports = { needsCalc, keepCurrent, makeHousekeeper, FRESH_MS };
