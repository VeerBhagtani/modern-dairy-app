/* Is the Modern Dairy depot (Market Yard, Pune) set up as a facility?
 *
 * Without one, no stop is ever a facility, so the drive back is never
 * RETURN_TO_MODERN_DAIRY and the departure is never MODERN_DAIRY_DEPARTURE —
 * both fall to "unknown" or "business travel" instead. This only CHECKS; it
 * never creates or moves a facility. The area centre is approximate (Market
 * Yard, Gultekdi) and used only to ask "is any facility roughly there?".
 */
'use strict';
const { haversineM } = require('../drivers/geo');

const MARKET_YARD_AREA = { lat: 18.487, lng: 73.866 };
const AREA_RADIUS_M = 2000;

function depotCheck(facilities) {
  const pinned = (facilities || []).filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng) && f.active !== false);
  const named = pinned.filter((f) => /market\s*yard/i.test(`${f.name || ''} ${f.address || ''} ${f.area || ''}`));
  const dists = pinned.map((f) => haversineM(f, MARKET_YARD_AREA));
  const nearestM = dists.length ? Math.round(Math.min(...dists)) : null;
  const nearMarketYard = nearestM != null && nearestM <= AREA_RADIUS_M;
  let warning = null;
  if (!pinned.length) warning = 'No Modern Dairy facility has a location, so returns to the depot are never recognised. Add the Market Yard depot under Locations → Modern Dairy depots.';
  else if (!nearMarketYard) warning = 'No facility is near Market Yard. Check the depot pin under Locations → Modern Dairy depots.';
  return { facilities: pinned.length, namedMarketYard: named.length, nearMarketYard, nearestToMarketYardM: nearestM, warning };
}

module.exports = { depotCheck, MARKET_YARD_AREA, AREA_RADIUS_M };
