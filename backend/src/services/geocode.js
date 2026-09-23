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

// Only EXACT is placed on the strength of the confidence alone. The rest are
// held — see canAutoPlace below for the one further case that is safe.
const AUTO_PLACE = new Set([CONFIDENCE.EXACT]);

/* Does the spreadsheet row carry a real street address, or just a
 * neighbourhood?
 *
 * This matters because it changes what a street-level match means. Geocoding
 * "Hotel Sai, Kothrud" to the middle of a road is a shrug. Geocoding
 * "32/A Hadapsar Industrial Estate, Pune" to the middle of that road is very
 * nearly right — the building is on it. A plot or shop number alongside a road
 * name is what separates the two, so that is what is looked for.
 */
function looksLikeStreetAddress(address) {
  const a = String(address || '').replace(/\s+/g, ' ').trim();
  if (a.length < 12) return false;
  if (!/\d/.test(a)) return false;              // no plot, shop or door number
  return a.split(/[\s,]+/).filter(Boolean).length >= 3;
}

/* Whether a result may become a location without a person looking at it.
 *
 * A confirmed pin is a geofence, so this stays narrow. Two cases pass:
 *
 *   EXACT                     the geocoder found the building itself.
 *
 *   APPROXIMATE, from a real  the right road, from an address the office
 *   street address, with no   typed — tens of metres out at worst, and a
 *   other candidate           driver standing on that road is genuinely there
 *                             on Modern Dairy business.
 *
 * AREA_ONLY never passes, whatever the row looks like: that is the centre of a
 * suburb, kilometres wide, and it would turn an errand across Kothrud into
 * billable distance. Nor does an ambiguous match, address or not — two
 * candidates means the geocoder does not know which restaurant this is.
 */
function canAutoPlace({ confidence, alternatives } = {}, { hasStreetAddress = false } = {}) {
  if (confidence === CONFIDENCE.EXACT) return true;
  return confidence === CONFIDENCE.APPROXIMATE && hasStreetAddress === true && !alternatives;
}

/* The query. Address first when there is one — it is worth far more than a
 * name — then name and area, and always the city and country, because
 * "Kothrud" alone matches places in several countries. */
function buildQuery({ name, area, address, city = 'Pune', region = 'Maharashtra', country = 'India' }) {
  const parts = [];
  if (address && address.trim()) parts.push(address.trim());
  else if (name && name.trim()) parts.push(name.trim());
  if (area && area.trim()) parts.push(area.trim());
  parts.push(city, region, country);
  // Addresses copied out of a spreadsheet carry line breaks and runs of spaces
  // from however they were typed; a query with a newline in the middle of it
  // is a worse query for no reason.
  const clean = (v) => String(v).replace(/\s+/g, ' ').trim();
  // Duplicates read badly to a geocoder: "Kothrud, Kothrud, Pune".
  const seen = new Set();
  return parts
    .map(clean)
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
async function geocodeOne(query, apiKey, { fetchImpl = fetch, hasStreetAddress = false } = {}) {
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
    autoPlace: canAutoPlace({ confidence, alternatives }, { hasStreetAddress }),
  };
}

module.exports = {
  CONFIDENCE,
  AUTO_PLACE,
  buildQuery,
  assessConfidence,
  assessResponse,
  canAutoPlace,
  looksLikeStreetAddress,
  toPoint,
  geocodeOne,
};
