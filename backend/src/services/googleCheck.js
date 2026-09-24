/* Confirming each restaurant's pin with Google Maps.
 *
 * A pin can come from many places: the Places API, a geocoded address, a
 * suburb the office accepted by hand, a click on the map. The office wants
 * every restaurant on the list checked against Google Maps, whichever way it
 * got there, so that "on the map" means "Google agrees it is here".
 *
 * The check never moves a pin. It asks Google for the business by name, near
 * Pune, and records what Google says against the pin the system is using:
 *
 *   confirmed     Google has this business, under this name, within
 *                 CONFIRM_RADIUS_M of the pin.
 *   moved         Google has this business, under this name, but somewhere
 *                 else — the pin is probably wrong. Google's position is kept
 *                 so the office can move the pin with one tap.
 *   name_differs  Google has a business right at the pin, under another name
 *                 ("Sai Palace" in the file, "Sai Restaurant" on Google). Most
 *                 often the same shop; a person should say so.
 *   not_found     Google cannot find this business near here at all.
 *
 * Moving a pin is left to a person, on purpose. A wrong pin moves the
 * geofence, and a moved geofence changes which drives count as business.
 */
'use strict';

const placesApi = require('./places');
const { haversineM } = require('../drivers/geo');

const STATUS = { CONFIRMED: 'confirmed', MOVED: 'moved', NAME_DIFFERS: 'name_differs', NOT_FOUND: 'not_found' };

// Within this of Google's own pin for the business counts as the same place.
// Wider than a geofence (80 m) because Google's pin is the building's
// centroid or its entrance, and a large hotel is not a point.
const CONFIRM_RADIUS_M = 150;
// A business Google holds under another name counts as "at the pin" only this
// close: further away it is just a neighbour.
const SAME_SPOT_M = 60;

/* The verdict for one restaurant, from what Places returned. Pure. */
function verdictFor(place, hit) {
  const at = Date.now();
  if (!hit || !hit.point) {
    return { status: STATUS.NOT_FOUND, at, detail: 'Google Maps has no business by this name near Pune.' };
  }
  const google = {
    googleLat: hit.point.lat,
    googleLng: hit.point.lng,
    googleName: hit.point.displayName || null,
    googleAddress: hit.point.formattedAddress || null,
    googlePlaceId: hit.point.placeId || null,
  };
  const distanceM = Math.round(haversineM({ lat: place.lat, lng: place.lng }, hit.point));
  if (hit.match === placesApi.MATCH.STRONG) {
    return distanceM <= CONFIRM_RADIUS_M
      ? { status: STATUS.CONFIRMED, at, distanceM, ...google, detail: `Google Maps has ${google.googleName || 'it'} ${distanceM} m from the pin.` }
      : { status: STATUS.MOVED, at, distanceM, ...google, detail: `Google Maps puts ${google.googleName || 'it'} ${distanceM} m from the pin.` };
  }
  if (distanceM <= SAME_SPOT_M) {
    return { status: STATUS.NAME_DIFFERS, at, distanceM, ...google, detail: `At the pin, Google Maps has "${google.googleName}".` };
  }
  return { status: STATUS.NOT_FOUND, at, distanceM, ...google, detail: `Google Maps has no clear match; its closest guess is "${google.googleName}", ${distanceM} m away.` };
}

async function checkOne(place, apiKey, opts) {
  const hit = await placesApi.searchOne({ name: place.name, area: place.area, address: place.address }, apiKey, opts);
  return verdictFor(place, hit);
}

// Which restaurants still need checking: those with a pin and no check, a
// check made against a pin that has since moved (the check is only as good as
// the pin it looked at), or — when re-checking everything — a check made
// before `before`. A re-check run passes the time it started to every batch,
// so each batch picks up where the last left off and the run ends.
function needsCheck(place, { before = null } = {}) {
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return false;
  if (place.active === false || place.mobile === true) return false;
  const c = place.googleCheck;
  if (!c || !c.at) return true;
  if (c.pinLat !== place.lat || c.pinLng !== place.lng) return true;
  return before != null && c.at < before;
}

module.exports = { STATUS, CONFIRM_RADIUS_M, SAME_SPOT_M, verdictFor, checkOne, needsCheck };
