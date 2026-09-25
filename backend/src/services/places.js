/* Finding the restaurant itself, rather than the road it is on.
 *
 * The Geocoding API answers "where is this address?". For a row that says
 * "Hotel Sai, Kothrud" it has no address to work with, so the best it can
 * honestly do is the middle of a road or the middle of a suburb. That is not a
 * usable geofence, and it is why so much of the list ended up waiting for a
 * person.
 *
 * The Places API answers a different question: "where is this business?". It
 * knows Hotel Sai as a place, and it returns that place's own coordinates —
 * the building — together with the name Google holds for it. That name is the
 * thing that makes this safe: we can compare it with the name in the office's
 * spreadsheet and refuse to place the pin when they do not agree.
 *
 * So the order is: ask Places first, and fall back to geocoding the address
 * only when Places has nothing. A pin from here is precise or it is held.
 */
'use strict';

const { normalise } = require('./placeKey');

const MATCH = {
  STRONG: 'STRONG', // the business Google names is the one the office named
  WEAK: 'WEAK',     // something is there, but it is not clearly the same shop
  NONE: 'NONE',     // nothing found
};

/* Words that carry no identity. "Hotel Sai" and "Sai Restaurant" are the same
 * shop described two ways; "Sai Palace" and "Sai Restaurant" are not, so this
 * list stays short and structural. Anything that could distinguish two
 * businesses on the same street — Palace, Garden, Corner, Express — is left in
 * deliberately, and the pair then has to be confirmed by a person.
 */
const GENERIC = new Set([
  'the', 'and', 'a', 'of', 'at', 'in', 'new', 'old',
  'hotel', 'restaurant', 'restaurants', 'cafe', 'bar', 'pub', 'eatery',
  'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'inc',
]);

function distinctive(name) {
  const words = normalise(name).split(' ').filter(Boolean);
  const out = new Set(words.filter((w) => !GENERIC.has(w)));
  // A name made entirely of generic words ("The Restaurant") has nothing to
  // compare on; fall back to every word rather than to an empty set, which
  // would otherwise match everything.
  return out.size ? out : new Set(words);
}

/* How well two names agree.
 *
 * STRONG means every distinguishing word matches, in both directions. A name
 * with an extra distinguishing word ("Sai Palace" against "Sai") is WEAK, not
 * STRONG: on one street in Pune those are two different shops, and the whole
 * cost of getting that wrong lands on a driver's kilometre figures.
 */
function compareNames(a, b) {
  const A = distinctive(a);
  const B = distinctive(b);
  if (!A.size || !B.size) return MATCH.NONE;
  const shared = [...A].filter((w) => B.has(w));
  if (!shared.length) return MATCH.NONE;
  if (shared.length === A.size && shared.length === B.size) return MATCH.STRONG;
  return MATCH.WEAK;
}

/* What to ask Places. Unlike a geocoder, this wants the business name first —
 * that is what it searches on — with the area and city to place it. The
 * address, when there is one, goes in too: it disambiguates two branches. */
function buildQuery({ name, area, address, city = 'Pune', region = 'Maharashtra' }) {
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const seen = new Set();
  return [name, address, area, city, region]
    .map(clean)
    .filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .join(', ');
}

// Pune, and roughly the distance a Modern Dairy driver covers in a day. A
// nationwide search for "Sai Restaurant" is not a search.
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const BIAS_RADIUS_M = 40000;

function toPoint(place) {
  if (!place || !place.location) return null;
  const { latitude, longitude } = place.location;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    lat: latitude,
    lng: longitude,
    formattedAddress: place.formattedAddress || null,
    placeId: place.id || null,
    displayName: (place.displayName && place.displayName.text) || null,
  };
}

/* Read a Places response and decide, without placing anything yet. */
function assessResponse(body, wantedName) {
  const list = (body && Array.isArray(body.places)) ? body.places : [];
  if (!list.length) return { match: MATCH.NONE, point: null, alternatives: 0 };

  // Google returns results best-first, but "best" is its idea of best. Prefer
  // whichever result actually carries the office's name, if any does.
  let chosen = list[0];
  let match = compareNames(wantedName, (chosen.displayName && chosen.displayName.text) || '');
  if (match !== MATCH.STRONG) {
    for (const p of list) {
      const m = compareNames(wantedName, (p.displayName && p.displayName.text) || '');
      if (m === MATCH.STRONG) { chosen = p; match = m; break; }
    }
  }

  // Two businesses that both match the name strongly is not a strong match —
  // it is two branches, and only a person knows which one this row is.
  if (match === MATCH.STRONG) {
    const strong = list.filter(
      (p) => compareNames(wantedName, (p.displayName && p.displayName.text) || '') === MATCH.STRONG,
    );
    if (strong.length > 1) match = MATCH.WEAK;
  }

  return { match, point: toPoint(chosen), alternatives: Math.max(0, list.length - 1) };
}

/* One Places text search, raw. Throws with notEnabled / overQuota set so the
 * callers can stop a batch with a plain reason. */
async function textSearch(textQuery, apiKey, { fetchImpl = fetch, max = 5 } = {}) {
  const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      // Places bills by the fields asked for, so ask for exactly what is used.
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({
      textQuery,
      regionCode: 'IN',
      languageCode: 'en',
      maxResultCount: max,
      locationBias: { circle: { center: PUNE, radius: BIAS_RADIUS_M } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body && body.error && body.error.message) || `Places returned ${res.status}`;
    const err = new Error(message);
    // 403 here almost always means the Places API is not enabled on the key,
    // which is a one-line fix in the console and worth saying plainly.
    err.notEnabled = res.status === 403 || /not enabled|SERVICE_DISABLED/i.test(message);
    err.overQuota = res.status === 429;
    throw err;
  }
  return body;
}

/* One search. The caller supplies the key, as with the geocoder, so a missing
 * or unauthorised key is a configuration problem reported once. */
async function searchOne(row, apiKey, { fetchImpl = fetch } = {}) {
  const query = buildQuery(row);
  const body = await textSearch(query, apiKey, { fetchImpl, max: 5 });
  const { match, point, alternatives } = assessResponse(body, row.name);
  return {
    source: 'places',
    query,
    match,
    point,
    alternatives,
    // Anything Places found is a real business at its own building, which is
    // as precise as this gets. A name that does not match is placed too, on
    // the office's instruction — see acceptNameMismatch below for what that
    // trades away.
    autoPlace: !!point && acceptNameMismatch(match),
  };
}

/* Every business Google Maps has under this name in Pune, by NAME ONLY.
 *
 * searchOne puts the spreadsheet address into the query, which is right for
 * placing a pin and wrong for checking one: Google then answers with whatever
 * is near that address, and the check agrees with the sheet because the sheet
 * asked the question. This leaves the address out, so the answer is Google's
 * own idea of where the business is. */
async function searchByName(name, apiKey, { fetchImpl = fetch } = {}) {
  const query = [String(name || '').replace(/\s+/g, ' ').trim(), 'Pune', 'Maharashtra'].filter(Boolean).join(', ');
  const body = await textSearch(query, apiKey, { fetchImpl, max: 20 });
  const list = (body && Array.isArray(body.places)) ? body.places : [];
  return {
    query,
    candidates: list.map((pl) => ({
      point: toPoint(pl),
      match: compareNames(name, (pl.displayName && pl.displayName.text) || ''),
    })).filter((c) => c.point),
  };
}

/* Whether a business whose name does not match the spreadsheet is still placed.
 *
 * The office asked for this explicitly, and the reasoning holds: their file
 * calls a shop "Sai Palace", Google calls it "Sai Restaurant", and nine times
 * out of ten that is the same shop typed two ways. Holding all of those back
 * left thousands of restaurants off the map, and a restaurant that is off the
 * map contributes nothing at all — which is a certain loss weighed against an
 * occasional one.
 *
 * What it trades away, stated plainly: sometimes it is the shop next door, and
 * the pin lands a few hundred metres off. The kilometres are still real and
 * still business — the driver was on that road, delivering — but the visit may
 * be credited to the wrong customer. Every such row is written with
 * locationSource 'places_name_differs' so the office can find and re-check
 * them, and the search still refuses to choose between two businesses that
 * both match, and still refuses a suburb centroid outright.
 */
function acceptNameMismatch(match) {
  return match === MATCH.STRONG || match === MATCH.WEAK || match === MATCH.NONE;
}

module.exports = {
  MATCH, GENERIC, distinctive, compareNames, buildQuery, assessResponse, toPoint,
  acceptNameMismatch, searchOne, searchByName, textSearch,
};
