/* Customers that are not at an address.
 *
 * The office's spreadsheet contains food trucks alongside restaurants. A truck
 * is a customer like any other — it buys milk, a driver delivers to it — but it
 * is not AT anywhere. Treating one like a building goes wrong twice over:
 *
 *   The lookup pays Google to find a street address that does not exist, and
 *   gets back the middle of a suburb.
 *
 *   Worse, if that pin is accepted it becomes a geofence in a place the truck
 *   may never park. Every driver who happens past it registers a visit that
 *   did not happen, and every real delivery to the truck registers nothing.
 *
 * So they are separated at import and kept out of the location machinery
 * entirely. They stay visible, stay in reports, and keep their own list — they
 * are customers, not rubbish. What they do not get is a pin pretending to be a
 * fact.
 *
 * The detection is a word match, which means it will be wrong sometimes: an
 * address on "Truck Terminal Road" is not a food truck. That is why the office
 * can move any row either way by hand, and why this file decides nothing that
 * cannot be undone from the screen.
 */
'use strict';

// Whole words only. "Truck" catches the vendors; a substring match would also
// catch nothing useful and several things wrongly.
const TRUCK = /\btrucks?\b/i;

/* Does this row look like a mobile vendor rather than a building?
 *
 * Both the name and the address are read: the office writes "Sai Food Truck"
 * in one column as often as "food truck, FC Road" in the other.
 */
function looksMobile({ name, address, area } = {}) {
  return TRUCK.test(String(name || ''))
    || TRUCK.test(String(address || ''))
    || TRUCK.test(String(area || ''));
}

// The status a mobile vendor carries instead of a location status. It is not
// 'pending' and not 'unconfirmed', so it never reaches the lookup queue, never
// appears in "needs a location", and never gets counted as work outstanding.
const MOBILE_STATUS = 'mobile';

function isMobile(place) {
  return !!place && (place.mobile === true || place.locationStatus === MOBILE_STATUS);
}

module.exports = { TRUCK, MOBILE_STATUS, looksMobile, isMobile };
