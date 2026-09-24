/* Coordinates from an order record, or null.
 *
 * Number('') and Number(null) are both 0 in JavaScript, so a blank latitude
 * cell used to become 0 — and an order with no location was stored at (0, 0),
 * in the Atlantic. Matching prefers an order's own coordinates over its
 * restaurant's, so that order was then 8,000 km from every stop, never
 * matched, and raised an "undelivered" alert on every ride. Blank, missing,
 * out of range, or (0, 0) all mean "this order does not say where": null, and
 * matching falls back to the restaurant's pin.
 */
'use strict';

function coord(v, limit) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

function orderCoords(latRaw, lngRaw) {
  const lat = coord(latRaw, 90);
  const lng = coord(lngRaw, 180);
  if (lat == null || lng == null) return { lat: null, lng: null };
  if (lat === 0 && lng === 0) return { lat: null, lng: null };
  return { lat, lng };
}

module.exports = { orderCoords };
