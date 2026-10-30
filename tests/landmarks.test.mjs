// A stop at no known place is named after the nearest restaurant (or, failing
// that, landmark) on Google Maps — a name only, never a customer, never km.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { pick, addLandmarks, lookupOne, keyOf } = require('./src/services/landmarks');
const { processRideData } = require('./src/drivers/pipeline');
const { buildReplay } = require('./src/services/replay');
const { buildJourney, applyLandmarks, stopsToName, CATEGORY } = require('./src/drivers/journey');
const { haversineM } = require('./src/drivers/geo');

const M = (dx, dy) => ({ lat: 18.50 + dy / 111320, lng: 73.86 + dx / (111320 * Math.cos(18.5 * Math.PI / 180)) });
const place = (name, types, dx, dy) => { const p = M(dx, dy); return { id: name, displayName: { text: name }, types, location: { latitude: p.lat, longitude: p.lng } }; };
const AT = M(0, 0);

test('a restaurant within 150 m wins over a nearer landmark', () => {
  const r = pick({ places: [place('Shree Medical', ['pharmacy'], 20, 0), place('Hotel Sai Palace', ['restaurant', 'food'], 90, 0)] }, AT);
  assert.equal(r.name, 'Hotel Sai Palace');
  assert.equal(r.kind, 'restaurant');
  assert.ok(Math.abs(r.distanceM - 90) <= 2);
});

test('no restaurant close by: the nearest landmark of any kind', () => {
  const r = pick({ places: [place('Far Cafe', ['cafe'], 250, 0), place('Kothrud Bus Depot', ['bus_station'], 60, 0), place('Petrol Pump', ['gas_station'], 40, 30)] }, AT);
  assert.equal(r.name, 'Petrol Pump');
  assert.equal(r.kind, 'landmark');
});

test('nothing within the radius, or nothing at all: no name, nothing guessed', () => {
  assert.equal(pick({ places: [place('Too Far', ['restaurant'], 900, 0)] }, AT), null);
  assert.equal(pick({}, AT), null);
});

test('the search asks for the nearest places, by distance, around the stop', async () => {
  let req;
  const fetchImpl = async (url, opts) => { req = { url, opts }; return { ok: true, json: async () => ({ places: [place('Hotel Sai Palace', ['restaurant'], 30, 0)] }) }; };
  const r = await lookupOne(AT.lat, AT.lng, 'KEY', { fetchImpl });
  assert.equal(r.name, 'Hotel Sai Palace');
  assert.match(req.url, /places:searchNearby$/);
  const body = JSON.parse(req.opts.body);
  assert.equal(body.rankPreference, 'DISTANCE');
  assert.equal(body.locationRestriction.circle.radius, 300);
  assert.equal(req.opts.headers['X-Goog-Api-Key'], 'KEY');
  assert.match(req.opts.headers['X-Goog-FieldMask'], /places\.displayName/);
});

test('one lookup per spot: cached, shared by nearby stops, capped, and silent without a key', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ places: [place('Hotel Sai Palace', ['restaurant'], 30, 0)] }) }; };
  const store = {};
  const cache = { getMany: async (keys) => Object.fromEntries(keys.filter((k) => store[k]).map((k) => [k, store[k]])), putMany: async (e) => Object.assign(store, e) };
  const a = { ...M(0, 0) }; const b = { ...M(5, 3) };   // same spot, a few metres apart
  await addLandmarks([a, b], { cache, apiKey: 'K', fetchImpl });
  assert.equal(calls, 1);
  assert.equal(a.landmark.name, 'Hotel Sai Palace');
  assert.equal(b.landmark.name, 'Hotel Sai Palace');
  const c = { ...M(0, 0) };
  await addLandmarks([c], { cache, apiKey: 'K', fetchImpl });
  assert.equal(calls, 1, 'from the cache the second time');
  assert.equal(c.landmark.name, 'Hotel Sai Palace');

  const far = [M(1000, 0), M(2000, 0), M(3000, 0)].map((p) => ({ ...p }));
  await addLandmarks(far, { cache, apiKey: 'K', fetchImpl, max: 2 });
  assert.equal(calls, 3, 'cap respected');
  assert.equal(far[2].landmark, undefined);

  const none = { ...M(5000, 0) };
  await addLandmarks([none], { cache: null, apiKey: null, fetchImpl });
  assert.equal(none.landmark, undefined);
  assert.equal(calls, 3);
});

test('a refused key stops the lookups and caches nothing', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 403, json: async () => ({ error: { message: 'Places API not enabled' } }) }; };
  const store = {};
  const cache = { getMany: async () => ({}), putMany: async (e) => Object.assign(store, e) };
  const items = [M(0, 0), M(1000, 0)].map((p) => ({ ...p }));
  await addLandmarks(items, { cache, apiKey: 'K', fetchImpl });
  assert.equal(calls, 1);
  assert.deepEqual(store, {});
  assert.equal(items[0].landmark, undefined);
  assert.notEqual(keyOf(18.5, 73.86), keyOf(18.501, 73.86));
});

// A real day: depot → A → an unknown spot → depot.
const T0 = Date.parse('2026-10-03T02:30:00Z');
const DEPOT = { id: 'depot', name: 'Modern Dairy, Market Yard', ...M(0, 0), radiusM: 150 };
const A = { id: 'A', name: 'Restaurant A', customerId: 'CA', ...M(2400, 0), radiusM: 80 };
const SPOT = M(4000, 2500);
function day(stops) {
  const pts = []; let t = T0; let n = 0; let here = stops[0];
  const fix = (p) => { pts.push({ clientPointId: `p${n += 1}`, lat: p.lat, lng: p.lng, deviceTs: t, accuracyM: 8, speedMps: 0 }); t += 20000; };
  for (const s of stops) {
    const steps = Math.max(1, Math.round(haversineM(here, s) / 160));
    for (let k = 1; k <= steps; k += 1) fix({ lat: here.lat + (s.lat - here.lat) * k / steps, lng: here.lng + (s.lng - here.lng) * k / steps });
    for (let k = 0; k < 18; k += 1) fix(s);
    here = s;
  }
  return pts;
}
const POINTS = day([DEPOT, A, SPOT, DEPOT]);
const ride = { id: 'r1', driverId: 'd1', startedAt: T0, status: 'completed' };
const proc = processRideData({ points: POINTS, ride, facilities: [DEPOT], restaurants: [A], orders: [], declarations: [], reviews: [], nowMs: T0 + 864e5 });

test('route legs: a stop at no known place is "Unknown stop", with its position to name it by', () => {
  const ends = proc.legs.flatMap((l) => [l.from, l.to]).filter((e) => e && e.kind === 'other');
  assert.ok(ends.length >= 1);
  for (const e of ends) {
    assert.equal(e.name, 'Unknown stop');
    assert.ok(haversineM(e, SPOT) < 40);
  }
  assert.ok(!JSON.stringify(proc.legs).includes('not a customer'));
});

test('the journey names the stop "Near …" everywhere, and nothing else changes', () => {
  const J = buildJourney({ ride, processing: proc, replay: buildReplay(POINTS, { ...proc, processedAt: T0 + 864e5 }), places: { facilities: [DEPOT], restaurants: [A] } });
  const before = JSON.parse(JSON.stringify(J));
  const want = stopsToName(J);
  assert.equal(want.length, 1, 'only the unknown stop — not the depot, not the restaurant');
  want[0].landmark = { name: 'Hotel Sai Palace', distanceM: 40, kind: 'restaurant' };
  applyLandmarks(J);
  const st = J.stops.find((s) => s.category === CATEGORY.UNKNOWN);
  assert.equal(st.label, 'Near Hotel Sai Palace');
  assert.equal(st.category, CATEGORY.UNKNOWN, 'still unknown: a name is not a customer');
  assert.equal(st.placeId, null);
  assert.ok(J.segments.some((g) => g.to.n === st.n && g.to.label === 'Near Hotel Sai Palace'));
  assert.ok(J.segments.some((g) => g.from.n === st.n && g.from.label === 'Near Hotel Sai Palace'));
  assert.equal(J.events.find((e) => e.kind === 'stop' && e.stop === st.n).label, 'Near Hotel Sai Palace');
  assert.deepEqual(J.totals, before.totals, 'every figure unchanged');
  assert.deepEqual(J.segments.map((g) => [g.distanceM, g.classification]), before.segments.map((g) => [g.distanceM, g.classification]));
  assert.equal(J.stops.find((s) => s.placeId === 'A').label, 'Restaurant A');
});
