/* Approximate street addresses for stops, from Google's reverse geocoder.
 *
 * Only for stops at no known place: a restaurant or the depot already has a
 * name and an address of its own. Cached for good in Firestore, keyed by the
 * point rounded to about 11 m, so one spot is paid for once however often the
 * office opens that day. A cap per request keeps an unusual day from turning
 * into a bill. No key, or an error, means no address — the stop still shows
 * with its coordinates; nothing is guessed.
 */
'use strict';

const MAX_NEW_PER_REQUEST = 25;
const key4 = (lat, lng) => `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;

async function reverseOne(lat, lng, apiKey, { fetchImpl = fetch } = {}) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=street_address|premise|route|sublocality&key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || (body.status !== 'OK' && body.status !== 'ZERO_RESULTS')) {
    throw new Error((body && (body.error_message || body.status)) || `Geocoding returned ${res.status}`);
  }
  const r = (body.results || [])[0];
  return r ? r.formatted_address : null;
}

/* Fills `address` on each stop that has none, in place. */
async function addAddresses(stops, { cache, apiKey, fetchImpl, max = MAX_NEW_PER_REQUEST } = {}) {
  const want = stops.filter((s) => !s.address && Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!want.length) return { looked: 0 };
  const keys = [...new Set(want.map((s) => key4(s.lat, s.lng)))];
  let known = {};
  try { known = cache ? (await cache.getMany(keys)) || {} : {}; } catch { known = {}; }
  const fresh = {};
  let looked = 0;
  for (const k of keys) {
    if (known[k] !== undefined || !apiKey || looked >= max) continue;
    const [lat, lng] = k.split(',').map(Number);
    try {
      // eslint-disable-next-line no-await-in-loop
      fresh[k] = { address: await reverseOne(lat, lng, apiKey, { fetchImpl }), at: Date.now() };
      looked += 1;
    } catch { break; }   // a refused key fails every call; stop asking
  }
  if (cache && Object.keys(fresh).length) await Promise.resolve(cache.putMany(fresh)).catch(() => {});
  for (const s of want) {
    const hit = fresh[key4(s.lat, s.lng)] || known[key4(s.lat, s.lng)];
    if (hit && hit.address) { s.address = hit.address; s.addressApproximate = true; }
  }
  return { looked };
}

module.exports = { addAddresses, reverseOne, key4 };
