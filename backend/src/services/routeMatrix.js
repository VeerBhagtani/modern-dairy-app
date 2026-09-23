/* Road distances for legs nobody has driven yet.
 *
 * This is the only part of the routing feature that costs money, so it is
 * built to be asked as little as possible. The caller works out which legs it
 * genuinely knows nothing about — not driven by this driver, not driven by
 * anyone in the fleet — and asks only about those. Everything else comes from
 * the company's own history for free.
 *
 * The consequence worth stating: this bill shrinks. In the first week almost
 * every leg is new; by the second month the same forty drivers are covering
 * the same roads and there is very little left to ask about.
 */
'use strict';

// Google bills per element, an element being one origin paired with one
// destination. A cap here stops a mistake upstream — a plan with forty stops,
// a loop that forgot to dedupe — turning into a bill.
const MAX_ELEMENTS = 100;

function toWaypoint({ lat, lng }) {
  return { waypoint: { location: { latLng: { latitude: lat, longitude: lng } } } };
}

/* Ask for a specific set of legs.
 *
 * @param legs   [{ from: stop, to: stop }] where a stop is { id, lat, lng }
 * @returns      { 'from>to': { distanceM, durationS } } for whatever came back
 *
 * Google's matrix endpoint is all-origins × all-destinations, so asking for
 * scattered pairs means asking for a rectangle and discarding most of it. That
 * is still far cheaper than asking about legs we already know, and the set of
 * unknown legs is usually small and clustered anyway.
 */
async function fetchLegs(legs, apiKey, { fetchImpl = fetch, departureTime = null } = {}) {
  if (!legs || !legs.length) return {};

  const origins = [...new Map(legs.map((l) => [l.from.id, l.from])).values()];
  const destinations = [...new Map(legs.map((l) => [l.to.id, l.to])).values()];
  if (origins.length * destinations.length > MAX_ELEMENTS) {
    throw new Error(
      `Refusing to price ${origins.length * destinations.length} route elements in one request.`,
    );
  }

  const body = {
    origins: origins.map(toWaypoint),
    destinations: destinations.map(toWaypoint),
    travelMode: 'DRIVE',
    // Only ask for live traffic when planning for now or later. Asking for a
    // past departure is rejected, and asking for traffic costs more.
    ...(departureTime
      ? { routingPreference: 'TRAFFIC_AWARE', departureTime: new Date(departureTime).toISOString() }
      : { routingPreference: 'TRAFFIC_UNAWARE' }),
  };

  const res = await fetchImpl('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      // Billed by field, as with Places. These four are the whole answer.
      'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,duration,condition',
    },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (payload && payload.error && payload.error.message) || `Routes returned ${res.status}`;
    const err = new Error(message);
    err.notEnabled = res.status === 403 || /not enabled|SERVICE_DISABLED/i.test(message);
    throw err;
  }

  return readMatrix(payload, origins, destinations);
}

/* Read the response into leg costs. Separated from the request so it can be
 * tested without a network, and because the response shape — index pairs into
 * the arrays that were sent — is easy to get subtly wrong. */
function readMatrix(payload, origins, destinations) {
  const out = {};
  const rows = Array.isArray(payload) ? payload : (payload && payload.rows) || [];
  for (const row of rows) {
    // ROUTE_NOT_FOUND comes back as a condition, not an error. A leg with no
    // road between the two points must stay unknown rather than become zero.
    if (row.condition && row.condition !== 'ROUTE_EXISTS') continue;
    const from = origins[row.originIndex];
    const to = destinations[row.destinationIndex];
    if (!from || !to || from.id === to.id) continue;
    const distanceM = Number(row.distanceMeters);
    const durationS = parseDuration(row.duration);
    if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(durationS)) continue;
    out[`${from.id}>${to.id}`] = { distanceM, durationS };
  }
  return out;
}

// Google returns durations as a protobuf Duration string: "1234s".
function parseDuration(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(v || ''));
  return m ? Number(m[1]) : NaN;
}

module.exports = { MAX_ELEMENTS, fetchLegs, readMatrix, parseDuration };
