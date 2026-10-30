/* A name for a stop at no known place: the nearest restaurant on Google Maps,
 * or failing that the nearest landmark.
 *
 * "Unknown stop" tells the office nothing; "Near Hotel Sai Palace (40 m)"
 * tells them where to look. This is a NAME only. It never makes the stop a
 * customer, never changes how the stop or its kilometres are classified, and
 * never feeds the calculation: the stop stays unknown until a person decides.
 *
 * One Places "nearby" search per spot, ranked by distance. A food place within
 * FOOD_MAX_M wins (that is what the office asked for, and what a dairy driver
 * most often stops beside); otherwise the nearest place of any kind within
 * the search radius. Cached for good in Firestore on a ~50 m grid, so a spot a
 * driver stops at every day is paid for once. A cap per request keeps an
 * unusual day from becoming a bill. No key, a refused key or an error means
 * no name — the stop keeps its plain label; nothing is guessed.
 */
'use strict';

const { placesPost } = require('./places');

const SEARCH_RADIUS_M = 300;
const FOOD_MAX_M = 150;
const MAX_NEW_PER_REQUEST = 25;
const GRID = 0.0005;   // ~55 m in Pune
const FOOD = new Set(['restaurant', 'cafe', 'bakery', 'bar', 'meal_takeaway', 'meal_delivery', 'food',
  'fast_food_restaurant', 'coffee_shop', 'tea_house', 'ice_cream_shop', 'dessert_shop', 'sweets_shop',
  'indian_restaurant', 'vegetarian_restaurant', 'pizza_restaurant', 'chinese_restaurant', 'sandwich_shop',
  'hotel', 'lodging', 'confectionery', 'juice_shop', 'food_court', 'dhaba']);

const snap = (v) => (Math.round(Number(v) / GRID) * GRID).toFixed(4);
const keyOf = (lat, lng) => `lm_${snap(lat)}_${snap(lng)}`;

function metres(a, b) {
  const t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t; const dLng = (b.lng - a.lng) * t;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* From a Places response, the place to name the stop after (or null). */
function pick(body, at) {
  const list = ((body && body.places) || [])
    .map((p) => ({
      name: p.displayName && p.displayName.text ? String(p.displayName.text).trim() : '',
      types: p.types || [],
      placeId: p.id || null,
      address: p.formattedAddress || null,
      distanceM: p.location ? Math.round(metres(at, { lat: p.location.latitude, lng: p.location.longitude })) : Infinity,
    }))
    .filter((p) => p.name && p.distanceM <= SEARCH_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM);
  if (!list.length) return null;
  const food = list.find((p) => p.distanceM <= FOOD_MAX_M && p.types.some((t) => FOOD.has(t)));
  const p = food || list[0];
  return { name: p.name, distanceM: p.distanceM, kind: food ? 'restaurant' : 'landmark', placeId: p.placeId, address: p.address, source: 'google' };
}

async function lookupOne(lat, lng, apiKey, { fetchImpl = fetch } = {}) {
  const body = await placesPost('https://places.googleapis.com/v1/places:searchNearby', {
    maxResultCount: 20,
    rankPreference: 'DISTANCE',
    languageCode: 'en',
    regionCode: 'IN',
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: SEARCH_RADIUS_M } },
  }, apiKey, { fetchImpl });
  return pick(body, { lat, lng });
}

/* Sets `landmark` on each item ({ lat, lng }) that can be named, in place. */
async function addLandmarks(items, { cache, apiKey, fetchImpl, max = MAX_NEW_PER_REQUEST } = {}) {
  const want = items.filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!want.length) return { looked: 0 };
  const keys = [...new Set(want.map((s) => keyOf(s.lat, s.lng)))];
  let known = {};
  try { known = cache ? (await cache.getMany(keys)) || {} : {}; } catch { known = {}; }
  const fresh = {};
  let looked = 0;
  for (const s of want) {
    const k = keyOf(s.lat, s.lng);
    if (known[k] !== undefined || fresh[k] !== undefined || !apiKey || looked >= max) continue;
    try {
      // The stop's own point, not the grid cell's centre: distances are real.
      // eslint-disable-next-line no-await-in-loop
      fresh[k] = { landmark: await lookupOne(s.lat, s.lng, apiKey, { fetchImpl }), at: Date.now() };
      looked += 1;
    } catch { break; }   // a refused key fails every call; stop asking
  }
  if (cache && Object.keys(fresh).length) await Promise.resolve(cache.putMany(fresh)).catch(() => {});
  for (const s of want) {
    const hit = fresh[keyOf(s.lat, s.lng)] || known[keyOf(s.lat, s.lng)];
    if (hit && hit.landmark) s.landmark = hit.landmark;
  }
  return { looked };
}

const nearLabel = (lm) => `Near ${lm.name}`;

module.exports = { addLandmarks, lookupOne, pick, keyOf, nearLabel, FOOD_MAX_M, SEARCH_RADIUS_M };
