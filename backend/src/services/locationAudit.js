/* Verifying every restaurant's stored location against Google Maps.
 *
 * For each restaurant: our stored coordinates, against where Google Maps has
 * the business — found by evidence, not by copying the first pin Google gives.
 *
 * SEARCH, in order, stopping as soon as there is a confident answer:
 *   1. name + address + area + city (+ phone), biased to our pin
 *   2. the name's identifying words only ("Shree Ganesh Hotel" → "ganesh"),
 *      with the area, biased to our pin — for when Google's name differs
 *   3. businesses within NEARBY_M of our pin — for when the name is not on
 *      Google at all but the shop is
 * plus the Excel sheet's address, geocoded on its own, as independent
 * evidence of where the customer is.
 *
 * EVIDENCE for each business Google offers:
 *   name     nameMatch.compare — kind words and honorifics set aside,
 *            spelling variants allowed; a match on common words only
 *            ("Sai", "Ganesh") is not enough by itself
 *   phone    the same number as ours: decisive
 *   place    near our pin, near the sheet's address, or in the sheet's area
 *
 * VERDICT, from our pin to the business Google has, measured against the
 * 80 m visit geofence:
 *   VERIFIED                ≤ 50 m   a driver at the business is well inside
 *                                    the geofence even with GPS error
 *   MINOR_DIFFERENCE        ≤ 100 m  inside or at the edge; visits may be
 *                                    missed on a poor-GPS day
 *   SIGNIFICANT_DIFFERENCE  > 100 m  a driver at the business is outside the
 *                                    geofence: visits will be missed
 *   NOT_FOUND               nothing on Google matches, by name or nearby
 *   NEEDS_MANUAL_REVIEW     some evidence, not enough — or two businesses
 *                           that fit equally well
 *
 * It NEVER moves a pin. It records what it found, how sure it is, why, and
 * what it recommends; a person applies it (see routes, and pinHistory.js for
 * the trail every move leaves).
 */
'use strict';

const placesApi = require('./places');
const geocode = require('./geocode');
const names = require('./nameMatch');
const { haversineM } = require('../drivers/geo');

const VERSION = 1;
const STATUS = {
  VERIFIED: 'VERIFIED',
  MINOR: 'MINOR_DIFFERENCE',
  SIGNIFICANT: 'SIGNIFICANT_DIFFERENCE',
  NOT_FOUND: 'NOT_FOUND',
  REVIEW: 'NEEDS_MANUAL_REVIEW',
};
const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };
const RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

// Against the 80 m default geofence; see the header.
const VERIFIED_M = 50;
const MINOR_M = 100;
// "Near our pin" as evidence that a business is ours.
const NEAR_PIN_M = 150;
const CLOSE_PIN_M = 300;
// Radius of the nearby search around our pin.
const NEARBY_M = 150;
// Two equally good candidates further apart than this cannot both be right.
const AMBIGUOUS_M = 300;
// How close the sheet's geocoded address must be, by how precise it is.
const ADDRESS_TOL_M = { EXACT: 250, APPROXIMATE: 500, AREA_ONLY: 2000 };

const SUBURB_SOURCES = new Set(['accepted_in_bulk_AREA_ONLY']);
const hasPin = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const fmt = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

// What the audit looked at. A changed sheet row, or a moved pin, makes the
// verdict stale.
function inputKey(p) {
  return [p.name, p.address, p.area, digits(p.phone)].map((s) => names.normalise(s)).join('|');
}
function isStale(p) {
  const a = p.locationAudit;
  if (!a || !a.at) return true;
  if (a.inputKey !== inputKey(p)) return true;
  if ((a.pinLat ?? null) !== (hasPin(p) ? p.lat : null) || (a.pinLng ?? null) !== (hasPin(p) ? p.lng : null)) return true;
  return false;
}
function needsAudit(p, { before = null } = {}) {
  if (!p || !p.name || p.active === false || p.mobile === true || p.locationStatus === 'mobile') return false;
  if (isStale(p)) return true;
  return before != null && p.locationAudit.at < before;
}
// Placed by a person, on purpose: evidence in its own right.
function placedByHand(p) {
  return p.locationSource === 'office' || p.locationSource === 'geocoded_confirmed'
    || /^office/.test(p.locationSource || '');
}

function toCandidate(pl, via) {
  const point = placesApi.toPoint(pl);
  if (!point) return null;
  return {
    via,
    placeId: point.placeId,
    name: point.displayName,
    address: point.formattedAddress,
    lat: point.lat,
    lng: point.lng,
    phone: pl.nationalPhoneNumber || pl.internationalPhoneNumber || null,
    types: Array.isArray(pl.types) ? pl.types.slice(0, 4) : [],
  };
}

/* Score one candidate against a restaurant. Pure. */
function assess(place, cand, ctx) {
  const nm = names.compare(place.name, cand.name || '');
  const out = { ...cand, name: cand.name, nameLevel: nm.level, nameScore: nm.score, evidence: [] };
  const pinUsable = hasPin(place) && !ctx.storedIsSuburb;
  if (pinUsable) out.distanceM = Math.round(haversineM(place, cand));
  if (ctx.address) out.addressM = Math.round(haversineM(ctx.address, cand));
  const addrOk = ctx.address && out.addressM <= (ADDRESS_TOL_M[ctx.address.confidence] || 500);
  const area = names.normalise(place.area);
  const areaOk = area.length >= 4 && names.normalise(cand.address).includes(area);
  const phoneOk = digits(place.phone).length === 10 && digits(cand.phone) === digits(place.phone);

  if (phoneOk) out.evidence.push('same phone number');
  if (nm.level !== names.LEVEL.NONE) out.evidence.push(`name ${nm.level} ("${cand.name}")`);
  if (pinUsable && out.distanceM <= NEAR_PIN_M) out.evidence.push(`${fmt(out.distanceM)} from our pin`);
  if (addrOk) out.evidence.push(`${fmt(out.addressM)} from the sheet's address`);
  if (areaOk) out.evidence.push(`Google's address is in ${place.area}`);

  const nearPin = pinUsable && out.distanceM <= NEAR_PIN_M;
  const closePin = pinUsable && out.distanceM <= CLOSE_PIN_M;
  const placeSupport = closePin || addrOk || areaOk;
  let conf = CONFIDENCE.LOW;
  if (phoneOk && nm.level !== names.LEVEL.NONE) conf = CONFIDENCE.HIGH;
  else if (nm.level === names.LEVEL.STRONG && placeSupport) conf = CONFIDENCE.HIGH;
  else if (nm.level === names.LEVEL.STRONG) conf = CONFIDENCE.MEDIUM;                   // the name, nowhere near our evidence
  else if (nm.level === names.LEVEL.PARTIAL && (nearPin || (addrOk && areaOk))) conf = CONFIDENCE.MEDIUM;
  else if (nm.level === names.LEVEL.COMMON && (nearPin || (addrOk && areaOk))) conf = CONFIDENCE.MEDIUM;
  else if (phoneOk) conf = CONFIDENCE.MEDIUM;
  out.confidence = conf;
  out.rank = RANK[conf] * 10 + nm.score * 5 + (nearPin ? 2 : 0) + (addrOk ? 1 : 0) + (phoneOk ? 5 : 0);
  return out;
}

/* Pick the best candidate, or say why none can be picked. Pure. */
function choose(place, cands, ctx) {
  const scored = dedupe(cands).map((c) => assess(place, c, ctx))
    .filter((c) => c.nameLevel !== names.LEVEL.NONE || c.confidence !== CONFIDENCE.LOW)
    .sort((a, b) => b.rank - a.rank);
  if (!scored.length) return { best: null, scored };
  const best = scored[0];
  // Two businesses that fit equally well and are far apart: a chain, or a
  // common name. Only a person can say which one this customer is.
  const rival = scored.find((c) => c !== best && c.confidence === best.confidence && c.nameLevel === best.nameLevel
    && Math.abs(c.rank - best.rank) < 2 && haversineM(c, best) > AMBIGUOUS_M);
  return { best, rival: rival || null, scored };
}
function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => c && !seen.has(c.placeId || `${c.lat},${c.lng}`) && seen.add(c.placeId || `${c.lat},${c.lng}`));
}

/* The verdict for one restaurant. Pure. */
function verdict(place, { best, rival, scored }, ctx) {
  const base = {
    version: VERSION,
    at: ctx.nowMs,
    by: 'system:location-audit',
    inputKey: inputKey(place),
    pinLat: hasPin(place) ? place.lat : null,
    pinLng: hasPin(place) ? place.lng : null,
    pinSource: place.locationSource || (hasPin(place) ? 'spreadsheet' : null),
    storedIsSuburb: ctx.storedIsSuburb,
    placedByHand: placedByHand(place),
    address: ctx.address ? { lat: ctx.address.lat, lng: ctx.address.lng, confidence: ctx.address.confidence, formatted: ctx.address.formatted || null } : null,
    searches: ctx.searches,
    candidates: scored.slice(0, 3).map((c) => ({ name: c.name, lat: c.lat, lng: c.lng, placeId: c.placeId, confidence: c.confidence, nameLevel: c.nameLevel, distanceM: c.distanceM ?? null })),
  };
  const found = best ? {
    name: best.name, address: best.address, lat: best.lat, lng: best.lng, placeId: best.placeId, via: best.via,
    nameLevel: best.nameLevel, phoneMatch: best.evidence.includes('same phone number'),
  } : null;

  if (!best) {
    return { ...base, status: STATUS.NOT_FOUND, confidence: null, found: null, distanceM: null,
      reason: `Google Maps has no business matching "${place.name}"`
        + (hasPin(place) && !ctx.storedIsSuburb ? `, and nothing within ${NEARBY_M} m of our pin looks like it` : '') + '.',
      action: hasPin(place) && !ctx.storedIsSuburb
        ? 'Check the pin on the map; confirm it or place it by hand. Nothing on Google to compare with.'
        : 'Place it by hand: Google has nothing to compare with and our position is not precise.' };
  }
  const why = best.evidence.join('; ');
  if (rival) {
    return { ...base, status: STATUS.REVIEW, confidence: CONFIDENCE.LOW, found, distanceM: best.distanceM ?? null,
      reason: `Two businesses fit equally well: "${best.name}" and "${rival.name}", ${fmt(haversineM(best, rival))} apart.`,
      action: 'Choose the right one on the map, or place it by hand.' };
  }
  if (best.confidence === CONFIDENCE.LOW) {
    return { ...base, status: STATUS.REVIEW, confidence: CONFIDENCE.LOW, found, distanceM: best.distanceM ?? null,
      reason: `Closest candidate is "${best.name}", but the evidence is weak (${why || 'name only partly similar'}).`,
      action: 'Look at it on the map and place it by hand if needed.' };
  }
  if (!hasPin(place) || ctx.storedIsSuburb) {
    const d = hasPin(place) ? Math.round(haversineM(place, best)) : null;
    const status = best.confidence === CONFIDENCE.HIGH && hasPin(place) ? STATUS.SIGNIFICANT : STATUS.REVIEW;
    return { ...base, status, confidence: best.confidence, found, distanceM: d,
      reason: (hasPin(place) ? `Our pin is only the centre of the suburb (${fmt(d)} from the business). ` : 'We have no position for it. ')
        + `Google Maps has "${best.name}" (${why}).`,
      action: best.confidence === CONFIDENCE.HIGH
        ? 'Move to Google\'s position: it is the business itself, ours is not.'
        : 'Check Google\'s position on the map, then apply it or place by hand.' };
  }

  const d = best.distanceM;
  let status = d <= VERIFIED_M ? STATUS.VERIFIED : d <= MINOR_M ? STATUS.MINOR : STATUS.SIGNIFICANT;
  // The sheet's own address can overrule a match that sits away from it.
  const addrDisagrees = ctx.address && ctx.address.confidence !== 'AREA_ONLY' && best.addressM > (ADDRESS_TOL_M[ctx.address.confidence] || 500) * 2;
  let confidence = best.confidence;
  if (addrDisagrees && confidence === CONFIDENCE.HIGH && !best.evidence.includes('same phone number')) confidence = CONFIDENCE.MEDIUM;
  let action;
  if (status === STATUS.VERIFIED) action = 'Keep the existing location.';
  else if (status === STATUS.MINOR) action = 'Keep, or move to Google\'s position if visits here are being missed.';
  else if (base.placedByHand) action = 'The office placed this pin by hand. Keep it unless you know it is wrong; compare on the map.';
  else if (confidence === CONFIDENCE.HIGH) action = 'Move to Google\'s position.';
  else action = 'Compare on the map before moving: the evidence is not conclusive.';
  if (status === STATUS.SIGNIFICANT && confidence !== CONFIDENCE.HIGH && !base.placedByHand) status = STATUS.REVIEW;
  return { ...base, status, confidence, found, distanceM: d,
    reason: `Google Maps has "${best.name}" ${fmt(d)} from our pin (${why}).`
      + (addrDisagrees ? ` The sheet's address is ${fmt(best.addressM)} from it.` : ''),
    action };
}

/* Run the searches for one restaurant and return the verdict. */
async function auditOne(place, apiKey, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const storedIsSuburb = SUBURB_SOURCES.has(place.locationSource);
  const pinUsable = hasPin(place) && !storedIsSuburb;
  const bias = pinUsable ? { lat: place.lat, lng: place.lng, radiusM: 3000 } : null;
  const phone = digits(place.phone).length === 10;
  const searches = [];
  const cands = [];
  const ctx = { storedIsSuburb, address: null, searches, nowMs };

  // The sheet's address, on its own, when there is one worth geocoding.
  const addressText = String(place.address || '').trim();
  const addrJob = addressText
    ? geocode.geocodeOne(geocode.buildQuery({ address: addressText, area: place.area }), apiKey, { fetchImpl })
      .then((r) => {
        searches.push('address');
        if (r.point && r.confidence !== geocode.CONFIDENCE.NONE) {
          ctx.address = { lat: r.point.lat, lng: r.point.lng, confidence: r.confidence, formatted: r.point.formattedAddress };
        }
      })
    : Promise.resolve();

  const run = async (via, fn) => {
    const body = await fn();
    searches.push(via);
    for (const pl of (body && body.places) || []) { const c = toCandidate(pl, via); if (c) cands.push(c); }
  };
  const confident = () => {
    const { best, rival } = choose(place, cands, ctx);
    return best && !rival && best.confidence === CONFIDENCE.HIGH;
  };

  // 1. The full description.
  const full = [place.name, addressText, place.area, 'Pune', phone ? place.phone : null].filter(Boolean).join(', ');
  await Promise.all([addrJob, run('name_address', () => placesApi.textSearch(full, apiKey, { fetchImpl, max: 10, bias, phone }))]);
  // 2. The identifying words, for a name Google spells differently.
  const short = names.shortName(place.name);
  if (!confident() && short && names.normalise(short) !== names.normalise(place.name)) {
    await run('short_name', () => placesApi.textSearch([short, place.area, 'Pune'].filter(Boolean).join(', '), apiKey, { fetchImpl, max: 10, bias, phone }));
  }
  // 3. What is actually around our pin.
  if (!confident() && pinUsable) {
    await run('nearby', () => placesApi.nearby({ lat: place.lat, lng: place.lng }, NEARBY_M, apiKey, { fetchImpl, phone }));
  }
  return verdict(place, choose(place, cands, ctx), ctx);
}

/* Whether a verdict may be applied without a person looking at each one:
 * the bulk "apply" button. Only a HIGH-confidence business a real distance
 * away, never a pin the office placed by hand. */
function bulkApplicable(p) {
  const a = p.locationAudit;
  if (!a || isStale(p) || !a.found || a.confidence !== CONFIDENCE.HIGH) return false;
  if (a.placedByHand) return false;
  return a.status === STATUS.SIGNIFICANT;
}

module.exports = {
  VERSION, STATUS, CONFIDENCE, VERIFIED_M, MINOR_M, NEARBY_M,
  inputKey, isStale, needsAudit, assess, choose, verdict, auditOne, bulkApplicable, placedByHand,
};
