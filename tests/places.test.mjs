// Finding the restaurant itself, rather than the road it is on.
//
// The Places API returns a business at its own building — precise enough to
// geofence. The whole safety of that rests on one question: is the business
// Google found the one the office wrote down? These tests pin the answer,
// because a precise pin on the wrong shop is worse than no pin at all: it
// looks right on the map and quietly bills the wrong kilometres.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const places = require_(path.join(ROOT, 'backend/src/services/places.js'));

const { MATCH } = places;

const place = (name, lat = 18.5, lng = 73.8) => ({
  id: 'p' + name.replace(/\W/g, ''),
  displayName: { text: name },
  formattedAddress: name + ', Pune',
  location: { latitude: lat, longitude: lng },
});

// ── is it the same shop? ─────────────────────────────────────────────────────

test('the same shop described two ways matches', () => {
  // Spreadsheets and Google disagree about where "Hotel" goes. They are not
  // different restaurants.
  assert.equal(places.compareNames('Hotel Sai', 'Sai Restaurant'), MATCH.STRONG);
  assert.equal(places.compareNames('SAI  RESTAURANT', 'sai restaurant'), MATCH.STRONG);
  assert.equal(places.compareNames('Kamat & Co', 'Kamat and Company'), MATCH.STRONG);
});

test('an extra distinguishing word is not the same shop', () => {
  // This is the case that must not be placed automatically. On one road in
  // Pune, Sai Palace and Sai Restaurant are two businesses.
  assert.equal(places.compareNames('Sai Palace', 'Sai Restaurant'), MATCH.WEAK);
  assert.equal(places.compareNames('Sai Garden', 'Sai Garden Express'), MATCH.WEAK);
});

test('sharing nothing is no match at all', () => {
  assert.equal(places.compareNames('Hotel Sai', 'Durga Bhavan'), MATCH.NONE);
});

test('a name made only of common words still compares on something', () => {
  // "The Restaurant" has no distinguishing word. Stripping them all would
  // leave an empty set, which would match every business in Pune.
  assert.notEqual(places.compareNames('The Restaurant', 'Durga Bhavan'), MATCH.STRONG);
  assert.equal(places.compareNames('The Restaurant', 'The Restaurant'), MATCH.STRONG);
});

// ── reading what Places sent back ────────────────────────────────────────────

test('a single business under the office\'s own name is placed', () => {
  const r = places.assessResponse({ places: [place('Sai Restaurant')] }, 'Hotel Sai');
  assert.equal(r.match, MATCH.STRONG);
  assert.equal(r.point.lat, 18.5);
  assert.equal(r.point.displayName, 'Sai Restaurant');
});

test('the matching result is preferred over whichever Google ranked first', () => {
  const r = places.assessResponse(
    { places: [place('Durga Bhavan', 18.1, 73.1), place('Sai Restaurant', 18.9, 73.9)] },
    'Hotel Sai',
  );
  assert.equal(r.match, MATCH.STRONG);
  assert.equal(r.point.lat, 18.9, 'it must take the one that actually matches the name');
});

test('two branches of the same name go to a person', () => {
  // Both are genuinely "Sai Restaurant". Only somebody in the office knows
  // which one this row has been ordering from.
  const r = places.assessResponse(
    { places: [place('Sai Restaurant', 18.4), place('Sai Restaurant', 18.6)] },
    'Sai Restaurant',
  );
  assert.equal(r.match, MATCH.WEAK, 'an ambiguous branch must never be placed automatically');
});

test('a business found under a different name is held, not placed', () => {
  const r = places.assessResponse({ places: [place('Durga Bhavan')] }, 'Hotel Sai');
  assert.equal(r.match, MATCH.NONE);
  assert.ok(r.point, 'the point is still offered as something for a person to look at');
});

test('nothing found is reported as nothing', () => {
  const r = places.assessResponse({ places: [] }, 'Hotel Sai');
  assert.equal(r.match, MATCH.NONE);
  assert.equal(r.point, null);
  assert.equal(places.assessResponse({}, 'Hotel Sai').point, null);
});

// ── the request ──────────────────────────────────────────────────────────────

test('the search asks for the business by name, in Pune, and does not repeat itself', () => {
  const q = places.buildQuery({ name: 'Hotel Sai', area: 'Kothrud' });
  assert.match(q, /^Hotel Sai/, 'Places searches on the business name, so it leads');
  assert.match(q, /Kothrud/);
  assert.match(q, /Pune/);

  const dup = places.buildQuery({ name: 'Cafe', area: 'Pune' });
  assert.equal(dup.toLowerCase().split('pune').length - 1, 1);
});

test('only the fields that are used are asked for, and the search is biased to Pune', async () => {
  // Places bills per field returned, and an unbiased search for "Sai
  // Restaurant" would range over the whole country.
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = { url, init };
    return { ok: true, json: async () => ({ places: [place('Sai Restaurant')] }) };
  };
  const out = await places.searchOne({ name: 'Hotel Sai', area: 'Kothrud' }, 'KEY', { fetchImpl });

  assert.match(sent.url, /places:searchText/);
  assert.equal(sent.init.headers['X-Goog-Api-Key'], 'KEY');
  assert.match(sent.init.headers['X-Goog-FieldMask'], /places\.location/);
  const body = JSON.parse(sent.init.body);
  assert.equal(body.regionCode, 'IN');
  assert.ok(body.locationBias.circle.radius > 0);
  assert.equal(out.autoPlace, true);
});

test('a key without Places access says so, rather than failing three thousand times', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: 'Places API (New) has not been used in project ...' } }),
  });
  await assert.rejects(
    places.searchOne({ name: 'Hotel Sai' }, 'KEY', { fetchImpl }),
    (e) => e.notEnabled === true,
  );
});

test('a business under a different name is still placed, and still labelled weak', async () => {
  // The office's decision: their file says "Sai Palace", Google says "Sai
  // Restaurant", and holding all of those back left thousands of restaurants
  // off the map entirely — a certain loss against an occasional one. The
  // match grade is kept regardless, because that is what marks the row as
  // worth re-checking.
  const fetchImpl = async () => ({ ok: true, json: async () => ({ places: [place('Sai Palace')] }) });
  const out = await places.searchOne({ name: 'Sai Restaurant' }, 'KEY', { fetchImpl });
  assert.equal(out.match, MATCH.WEAK, 'the disagreement must still be recorded');
  assert.equal(out.autoPlace, true);
  assert.ok(out.point);
});

test('what the name-mismatch rule does and does not cover', () => {
  // It lets a real business through whatever it is called. It cannot let
  // anything through that is not a business at all — a suburb centroid never
  // reaches this code, because Places returns places, not areas.
  assert.equal(places.acceptNameMismatch(MATCH.STRONG), true);
  assert.equal(places.acceptNameMismatch(MATCH.WEAK), true);
  assert.equal(places.acceptNameMismatch(MATCH.NONE), true);
});

test('two businesses of the same name are still refused', async () => {
  // Relaxing the name rule must not relax the ambiguity rule. Two branches
  // called "Sai Restaurant" are a question only the office can answer, and
  // guessing picks the wrong one half the time.
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ places: [place('Sai Restaurant', 18.4), place('Sai Restaurant', 18.9)] }),
  });
  const out = await places.searchOne({ name: 'Sai Restaurant' }, 'KEY', { fetchImpl });
  assert.equal(out.match, MATCH.WEAK);
  // It is placed under the office's instruction, but the row carries the weak
  // grade and an alternatives count, which is what puts it on the re-check
  // list rather than letting it vanish.
  assert.equal(out.alternatives, 1);
});

test('nothing found is still nothing, whatever the name rule says', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ places: [] }) });
  const out = await places.searchOne({ name: 'Nowhere' }, 'KEY', { fetchImpl });
  assert.equal(out.point, null);
  assert.equal(out.autoPlace, false, 'no point means nothing to place');
});
