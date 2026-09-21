/* Turning "Hotel Sai, Kothrud" into a point on the map — carefully.
 *
 * A restaurant's coordinates are not a display detail here. They are a
 * geofence, and a geofence is what decides whether a driver "visited" a
 * customer, which decides whether kilometres count as Modern Dairy business.
 * A pin in the wrong place does not look wrong on a map; it quietly turns
 * somebody's trip to the shops into billable distance.
 *
 * Geocoding a name and an area is genuinely unreliable. "Sai Restaurant,
 * Kothrud" can match a dozen places or none, and the geocoder will happily
 * return the centre of Kothrud with no hint that it has really just shrugged.
 *
 * So this module's job is not to find coordinates. It is to decide, honestly,
 * whether what came back is good enough to act on — and to say so when it is
 * not, rather than placing a pin and letting the pipeline treat a guess as a
 * fact. Everything it is unsure about goes to a person.
 */
'use strict';

const CONFIDENCE = {
  EXACT: 'EXACT',           // a specific building; safe to place
  APPROXIMATE: 'APPROXIMATE', // the right street or block; a person should look
  AREA_ONLY: 'AREA_ONLY',   // the centre of a suburb — useless as a geofence
  NONE: 'NONE',             // nothing came back
};

// Only EXACT is placed without a person looking at it. The rest are held.
const AUTO_PLACE = new Set([CONFIDENCE.EXACT]);

/* The query. Address first when there is one — it is worth far more than a
 * name — then name and area, and always the city and country, because
 * "Kothrud" alone matches places in several countries. */
function buildQuery({ name, area, address, city = 'Pune', region = 'Maharashtra', country = 'India' }) {
  const parts = [];
  if (address && address.trim()) parts.push(address.trim());
  else if (name && name.trim()) parts.push(name.trim());
  if (area && area.trim()) parts.push(area.trim());
  parts.push(city, region, country);
  // Duplicates read badly to a geocoder: "Kothrud, Kothrud, Pune".
  const seen = new Set();
  return parts
    .map((p) => String(p).trim())
    .filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .join(', ');
}

/* Google reports how it found a place. The mapping below is deliberately
 * pessimistic:
 *
 *   ROOFTOP             a specific building            → EXACT
 *   RANGE_INTERPOLATED  guessed along a street         → APPROXIMATE
 *   GEOMETRIC_CENTER    centre of a road or polygon    → APPROXIMATE
 *   APPROXIMATE         centre of a suburb or city     → AREA_ONLY
 *
 * partial_match means Google could not match the whole query and substituted
 * something. That is exactly the case that produces a confident-looking pin on
 * the wrong restaurant, so it can never be EXACT however precise the geometry
 * claims to be.
 */
function assessConfidence(result) {
  if (!result || !result.geometry || !result.geometry.location) return CONFIDENCE.NONE;
  const type = result.geometry.location_type;
  if (type === 'APPROXIMATE') return CONFIDENCE.AREA_ONLY;
  if (result.partial_match === true) return CONFIDENCE.APPROXIMATE;
  if (type === 'ROOFTOP') return CONFIDENCE.EXACT;
  if (type === 'RANGE_INTERPOLATED' || type === 'GEOMETRIC_CENTER') return CONFIDENCE.APPROXIMATE;
  return CONFIDENCE.APPROXIMATE;
}

/* More than one plausible answer means the name was ambiguous, and picking the
 * first is how the wrong restaurant ends up on the map. Downgrade rather than
 * choose. */
function assessResponse(body) {
  if (!body || body.status === 'ZERO_RESULTS' || !Array.isArray(body.results) || !body.results.length) {
    return { confidence: CONFIDENCE.NONE, result: null, alternatives: 0 };
  }
  const result = body.results[0];
  let confidence = assessConfidence(result);
  const alternatives = body.results.length - 1;
  if (alternatives > 0 && confidence === CONFIDENCE.EXACT) confidence = CONFIDENCE.APPROXIMATE;
  return { confidence, result, alternatives };
}

function toPoint(result) {
  if (!result) return null;
  const loc = result.geometry.location;
  return {
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress: result.formatted_address || null,
    placeId: result.place_id || null,
  };
}

/* One lookup. The caller supplies the key so this stays testable and so a
 * missing key is a configuration problem reported once, not a thousand times. */
async function geocodeOne(query, apiKey, { fetchImpl = fetch } = {}) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json'
    + `?address=${encodeURIComponent(query)}`
    + '&components=country:IN'
    + `&key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);
  const body = await res.json();
  if (body.status === 'REQUEST_DENIED' || body.status === 'INVALID_REQUEST') {
    throw new Error(`Geocoder refused the request: ${body.error_message || body.status}`);
  }
  if (body.status === 'OVER_QUERY_LIMIT') throw new Error('OVER_QUERY_LIMIT');
  const { confidence, result, alternatives } = assessResponse(body);
  return {
    query,
    confidence,
    alternatives,
    point: toPoint(result),
    autoPlace: AUTO_PLACE.has(confidence),
  };
}

module.exports = { CONFIDENCE, AUTO_PLACE, buildQuery, assessConfidence, assessResponse, toPoint, geocodeOne };
