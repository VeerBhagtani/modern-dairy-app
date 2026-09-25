/* Does the address in the office's Excel sheet match where Google Maps has
 * the restaurant?
 *
 * Two lookups, kept independent of each other on purpose:
 *
 *   the sheet   the address (and area) from the Excel sheet, geocoded on its
 *               own — no restaurant name, so Google cannot "help" by finding
 *               the business;
 *   Google      the restaurant looked up on Google Maps by its NAME only — no
 *               address, so Google cannot just answer with whatever is near
 *               the address the sheet gave it.
 *
 * The older pin check put the sheet's address into the Places query, and most
 * pins were placed by that same query in the first place, so it mostly
 * confirmed itself. This compares two answers that do not know about each
 * other.
 *
 *   match        Google has a business with this name close to the sheet's
 *                address (how close depends on how precise the address is).
 *   far          Google has it, but nowhere near the sheet's address.
 *   no_business  Google Maps has no business with this name in Pune.
 *   no_address   the sheet has no address Google can find, so there is
 *                nothing to compare with.
 *
 * A chain with several branches is compared by its branch nearest the
 * sheet's address: the question is whether there is one there.
 */
'use strict';

const placesApi = require('./places');
const geocode = require('./geocode');
const { haversineM } = require('../drivers/geo');

const STATUS = { MATCH: 'match', FAR: 'far', NO_BUSINESS: 'no_business', NO_ADDRESS: 'no_address' };

// How far apart the sheet's address and Google's business may be and still
// count as the same place. A building-level address is held tight; a road or
// a suburb covers ground, so it gets more room — and the screen says which.
const TOLERANCE_M = {
  [geocode.CONFIDENCE.EXACT]: 250,
  [geocode.CONFIDENCE.APPROXIMATE]: 500,
  [geocode.CONFIDENCE.AREA_ONLY]: 2000,
};
const PRECISION_LABEL = {
  [geocode.CONFIDENCE.EXACT]: 'building',
  [geocode.CONFIDENCE.APPROXIMATE]: 'street',
  [geocode.CONFIDENCE.AREA_ONLY]: 'area only',
};

// What the check looked at. When the sheet is re-imported with a different
// name or address, the old verdict no longer describes the row.
function inputKey(p) {
  return [p.name, p.address, p.area].map((s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()).join('|');
}

function needsCheck(place, { before = null } = {}) {
  if (!place || !place.name || place.active === false || place.mobile === true || place.locationStatus === 'mobile') return false;
  const c = place.sheetCheck;
  if (!c || !c.at) return true;
  if (c.inputKey !== inputKey(place)) return true;
  return before != null && c.at < before;
}

const round = (m) => Math.round(m);
const hasPin = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng);
const fmt = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

/* The verdict, from the two lookups. Pure.
 * @param addr   geocodeOne result for the sheet's address, or null
 * @param found  searchByName result: { candidates: [{ point, match }] }
 */
function verdictFor(place, addr, found) {
  const at = Date.now();
  const base = { at, inputKey: inputKey(place) };
  const addrOk = addr && addr.point && addr.confidence && addr.confidence !== geocode.CONFIDENCE.NONE;
  if (addrOk) {
    Object.assign(base, {
      addressLat: addr.point.lat,
      addressLng: addr.point.lng,
      addressFormatted: addr.point.formattedAddress || null,
      addressPrecision: PRECISION_LABEL[addr.confidence] || 'street',
    });
  }

  // Same name first; a business sharing only part of the name is used only
  // when Google has nothing with the full name, and is labelled as such.
  const cands = (found && found.candidates) || [];
  const strong = cands.filter((c) => c.match === placesApi.MATCH.STRONG);
  const named = strong.length ? strong : cands.filter((c) => c.match === placesApi.MATCH.WEAK);
  if (!named.length) {
    const guess = cands[0] && cands[0].point;
    return {
      ...base,
      status: STATUS.NO_BUSINESS,
      googleGuess: guess ? guess.displayName : null,
      detail: `Google Maps has no business called "${place.name}" in Pune`
        + (guess && guess.displayName ? ` (its closest result is "${guess.displayName}")` : '') + '.',
      ...pinDistances(place, base, null),
    };
  }

  const pick = addrOk
    ? named.reduce((best, c) => (haversineM(addr.point, c.point) < haversineM(addr.point, best.point) ? c : best))
    : named[0];
  const g = pick.point;
  const google = {
    googleLat: g.lat,
    googleLng: g.lng,
    googleName: g.displayName || null,
    googleAddress: g.formattedAddress || null,
    googlePlaceId: g.placeId || null,
    nameMatch: strong.length ? 'same' : 'partial',
    branches: named.length,
  };

  if (!addrOk) {
    return {
      ...base, ...google,
      status: STATUS.NO_ADDRESS,
      detail: (place.address || place.area)
        ? 'Google cannot find the address in the sheet, so there is nothing to compare with.'
        : 'The sheet has no address for this restaurant, so there is nothing to compare with.',
      ...pinDistances(place, base, g),
    };
  }

  const apartM = round(haversineM(addr.point, g));
  const tol = TOLERANCE_M[addr.confidence] || 500;
  const status = apartM <= tol ? STATUS.MATCH : STATUS.FAR;
  return {
    ...base, ...google,
    status,
    apartM,
    toleranceM: tol,
    detail: status === STATUS.MATCH
      ? `Google Maps has ${google.googleName || 'it'} ${fmt(apartM)} from the sheet's address.`
      : `Google Maps has ${google.googleName || 'it'} ${fmt(apartM)} from the sheet's address`
        + ` (allowed: ${fmt(tol)} for a ${base.addressPrecision}-level address).`,
    ...pinDistances(place, base, g),
  };
}

// Where the pin in use sits relative to each answer, so the office can see
// which one it follows.
function pinDistances(place, base, g) {
  if (!hasPin(place)) return { pinLat: null, pinLng: null };
  const out = { pinLat: place.lat, pinLng: place.lng };
  if (g) out.pinToGoogleM = round(haversineM(place, g));
  if (Number.isFinite(base.addressLat)) out.pinToAddressM = round(haversineM(place, { lat: base.addressLat, lng: base.addressLng }));
  return out;
}

async function checkOne(place, apiKey, opts = {}) {
  const hasAddr = !!(String(place.address || '').trim() || String(place.area || '').trim());
  const [addr, found] = await Promise.all([
    hasAddr
      ? geocode.geocodeOne(geocode.buildQuery({ address: place.address || place.area, area: place.address ? place.area : null }), apiKey, opts)
      : Promise.resolve(null),
    placesApi.searchByName(place.name, apiKey, opts),
  ]);
  return verdictFor(place, addr, found);
}

module.exports = { STATUS, TOLERANCE_M, inputKey, needsCheck, verdictFor, checkOne };
