/* Can a driver be sent to this restaurant today?
 *
 * This is asked in two places — the list the app offers, and the planner that
 * builds a round — and they must never disagree. A restaurant hidden from the
 * list but still accepted by the planner is a restaurant a driver reaches by
 * re-using yesterday's round, which is exactly the case the office is trying
 * to prevent when they put supply on hold.
 *
 * So the decision lives here, once, and both callers ask it.
 *
 * Note what is NOT decided here: whether the geofence stays on. It does. If a
 * driver goes to a held restaurant anyway, the visit is still detected and
 * still recorded — the office needs to see that far more than it needs a tidy
 * map, and a silently missing geofence would make the trip look like a drive
 * to nowhere.
 */
'use strict';

const INELIGIBLE = {
  INACTIVE: 'inactive',       // the customer is gone; the row is history
  ON_HOLD: 'on_hold',         // stop supplying today, expect to resume
  NO_LOCATION: 'no_location', // nobody has placed it on the map yet
};

/* @param place a restaurant row
 * @returns { ok: true } or { ok: false, reason, message }
 *
 * The message is written to be shown to a driver on a phone, because that is
 * where most of these end up.
 */
function stopEligibility(place) {
  if (!place) return { ok: false, reason: INELIGIBLE.NO_LOCATION, message: 'This restaurant is not in the system.' };

  if (place.active === false) {
    return { ok: false, reason: INELIGIBLE.INACTIVE, message: 'This customer is no longer active.' };
  }

  // Checked before the location, because "supply is on hold" is the useful
  // thing to tell somebody even about a restaurant that also has no pin.
  if (place.supplyHold === true) {
    return {
      ok: false,
      reason: INELIGIBLE.ON_HOLD,
      message: place.holdReason
        ? `Supply is on hold — ${place.holdReason}`
        : 'Supply to this restaurant is on hold.',
    };
  }

  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
    return {
      ok: false,
      reason: INELIGIBLE.NO_LOCATION,
      message: 'This restaurant has no location yet. Ask the office to place it on the map.',
    };
  }

  return { ok: true };
}

const canVisit = (place) => stopEligibility(place).ok;

module.exports = { INELIGIBLE, stopEligibility, canVisit };
