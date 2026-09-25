/* Every change to a restaurant's pin, kept.
 *
 * A pin is a geofence, and a geofence decides which kilometres count as
 * business. So no route may overwrite lat/lng on its own: they all go through
 * pinChange, which returns the fields to write and one history entry saying
 *
 *   where the pin was (and where that came from)
 *   → why it moved (the verification, the person, the reason)
 *   → where it is now.
 *
 * The very first position a restaurant ever had is also kept, once, as
 * `originalLocation`, and never overwritten after that.
 *
 * Pure: the caller appends `entry` to `locationHistory` with
 * FieldValue.arrayUnion, so two moves at once cannot lose each other.
 */
'use strict';

const hasPin = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

/**
 * @param before the restaurant as it is now
 * @param to { lat, lng, source, by, reason, verification? }
 *   source        what the new position is, e.g. 'google_places', 'office'
 *   by            'admin:<id>' or 'system:<process>'
 *   reason        one sentence a person can read later
 *   verification  the location-audit verdict the move was based on, if any
 * @returns {{ fields: object, entry: object }}
 */
function pinChange(before, to, nowMs = Date.now()) {
  if (!Number.isFinite(to.lat) || !Number.isFinite(to.lng)) throw new Error('pinChange needs a position');
  if (!to.source || !to.by || !to.reason) throw new Error('pinChange needs source, by and reason');
  const from = hasPin(before)
    ? { lat: before.lat, lng: before.lng, source: before.locationSource || (before.importedAt ? 'spreadsheet' : 'unknown') }
    : null;
  const entry = {
    at: nowMs,
    by: to.by,
    from,
    to: { lat: to.lat, lng: to.lng, source: to.source },
    reason: String(to.reason).slice(0, 300),
    verification: to.verification || null,
  };
  const fields = {
    lat: to.lat,
    lng: to.lng,
    locationSource: to.source,
    locationStatus: 'confirmed',
    locationChangedAt: nowMs,
    locationChangedBy: to.by,
  };
  // The first position this restaurant ever had, kept once and never touched
  // again, so "where was it originally?" always has an answer.
  if (from && !before.originalLocation) fields.originalLocation = { ...from, keptAt: nowMs };
  return { fields, entry };
}

/* Taking a pin away (a restaurant that turns out to be a food truck). The
 * position is not lost: it goes into the history, and into `removedPin` so it
 * can be put back if the flag was a mistake. */
function pinRemoval(before, { by, reason }, nowMs = Date.now()) {
  if (!by || !reason) throw new Error('pinRemoval needs by and reason');
  if (!hasPin(before)) return { fields: {}, entry: null };
  const from = { lat: before.lat, lng: before.lng, source: before.locationSource || 'unknown' };
  const fields = { lat: null, lng: null, removedPin: { ...from, at: nowMs, by }, locationChangedAt: nowMs, locationChangedBy: by };
  if (!before.originalLocation) fields.originalLocation = { ...from, keptAt: nowMs };
  return { fields, entry: { at: nowMs, by, from, to: null, reason: String(reason).slice(0, 300), verification: null } };
}

module.exports = { pinChange, pinRemoval, hasPin };
