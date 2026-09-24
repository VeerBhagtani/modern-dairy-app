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

function needsCalc(ride, nowMs, { freshMs = FRESH_MS } = {}) {
  if (!ride || !ride.pointCount) return false;                  // nothing to calculate from
  if (!ride.processedAt) return true;
  const newPoints = (ride.lastUploadAt || 0) > ride.processedAt;
  if (!newPoints) return false;
  if (ride.status === 'active') return nowMs - ride.processedAt >= freshMs;
  return true;
}

/* @param rides   ride rows (with id, status, pointCount, processedAt, lastUploadAt)
 * @param deps    { processOne(rideId), now() }
 * @param opts    { maxRides, budgetMs, freshMs }
 * @returns { calculated: [rideId], failed: [{rideId,error}], deferred: n }
 *
 * Oldest-calculated first, so a backlog is worked through fairly rather than
 * the same few rides being refreshed while others wait.
 */
async function keepCurrent(rides, deps, { maxRides = 10, budgetMs = 8000, freshMs = FRESH_MS } = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const due = rides
    .filter((r) => needsCalc(r, now, { freshMs }))
    .sort((a, b) => (a.processedAt || 0) - (b.processedAt || 0));
  const calculated = []; const failed = [];
  const started = deps.now ? deps.now() : Date.now();
  for (const ride of due) {
    if (calculated.length + failed.length >= maxRides) break;
    if ((deps.now ? deps.now() : Date.now()) - started > budgetMs) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      await deps.processOne(ride.id);
      calculated.push(ride.id);
    } catch (e) {
      // One ride's failure must not stop the rest, or the dashboard.
      failed.push({ rideId: ride.id, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  return { calculated, failed, deferred: due.length - calculated.length - failed.length };
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
