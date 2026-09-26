/* Customers served by Modern Dairy's own delivery truck, not by the drivers.
 *
 * They are real customers in the office's list, but Modern Drivers never
 * visits them: no pin, no geofence, not a stop anyone can plan, not counted
 * as "needs a location". Marked by hand from the Locations tab, and
 * reversible there.
 *
 * Not the same as a food truck (mobileVendor.js): that is a customer with no
 * fixed address that the drivers DO serve.
 */
'use strict';

// Its own status, so it never reaches the lookup queue ('pending'), the
// place-by-hand list ('unconfirmed') or the location audit.
const TRUCK_ROUTE_STATUS = 'truck_route';

function isTruckRoute(place) {
  return !!place && (place.truckRoute === true || place.locationStatus === TRUCK_ROUTE_STATUS);
}

module.exports = { TRUCK_ROUTE_STATUS, isTruckRoute };
