// Turning a spreadsheet row into a point on the map.
//
// These tests are about one question: when is a geocoder's answer good enough
// to become a geofence? A restaurant's pin decides whether a driver "visited"
// a customer, and that decides whether kilometres are billable. A confident
// pin in the wrong place is the worst outcome this system can produce, so the
// rules below are deliberately pessimistic and are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const geo = require_(path.join(ROOT, 'backend/src/services/geocode.js'));
const { placeIdFor, normalise } = require_(path.join(ROOT, 'backend/src/services/placeKey.js'));

const at = (location_type, extra = {}) => ({
  geometry: { location: { lat: 18.5, lng: 73.8 }, location_type },
  formatted_address: 'somewhere',
  ...extra,
});

test('only a rooftop match is placed without a person looking', () => {
  assert.equal(geo.assessConfidence(at('ROOFTOP')), geo.CONFIDENCE.EXACT);
  assert.ok(geo.AUTO_PLACE.has(geo.CONFIDENCE.EXACT));

  for (const t of ['RANGE_INTERPOLATED', 'GEOMETRIC_CENTER']) {
    assert.equal(geo.assessConfidence(at(t)), geo.CONFIDENCE.APPROXIMATE);
    assert.ok(!geo.AUTO_PLACE.has(geo.CONFIDENCE.APPROXIMATE));
  }
});

test('the centre of a suburb is never a restaurant', () => {
  // This is the dangerous case: Google returns the middle of Kothrud with full
  // confidence in its own terms, and it would geofence a whole neighbourhood.
  assert.equal(geo.assessConfidence(at('APPROXIMATE')), geo.CONFIDENCE.AREA_ONLY);
  assert.ok(!geo.AUTO_PLACE.has(geo.CONFIDENCE.AREA_ONLY));
});

test('a partial match is never treated as exact, however precise it claims to be', () => {
  // partial_match means Google could not match the whole query and substituted
  // something — precisely how a confident pin lands on the wrong restaurant.
  assert.equal(geo.assessConfidence(at('ROOFTOP', { partial_match: true })), geo.CONFIDENCE.APPROXIMATE);
});

test('more than one candidate downgrades an exact match', () => {
  const one = geo.assessResponse({ status: 'OK', results: [at('ROOFTOP')] });
  assert.equal(one.confidence, geo.CONFIDENCE.EXACT);
  assert.equal(one.alternatives, 0);

  const many = geo.assessResponse({ status: 'OK', results: [at('ROOFTOP'), at('ROOFTOP')] });
  assert.equal(many.confidence, geo.CONFIDENCE.APPROXIMATE, 'an ambiguous name must go to a person');
  assert.equal(many.alternatives, 1);
});

test('no results is reported as nothing, not as a point', () => {
  const r = geo.assessResponse({ status: 'ZERO_RESULTS', results: [] });
  assert.equal(r.confidence, geo.CONFIDENCE.NONE);
  assert.equal(r.result, null);
  assert.equal(geo.toPoint(null), null);
});

test('the query carries the city and country, and does not repeat itself', () => {
  const q = geo.buildQuery({ name: 'Hotel Sai', area: 'Kothrud' });
  assert.match(q, /Hotel Sai/);
  assert.match(q, /Kothrud/);
  assert.match(q, /Pune/);
  assert.match(q, /India/);

  // "Pune" given as the area must not produce "Pune, Pune".
  const dup = geo.buildQuery({ name: 'Cafe', area: 'Pune' });
  assert.equal(dup.toLowerCase().split('pune').length - 1, 1);
});

test('an address is preferred over a name, because it is worth far more', () => {
  const q = geo.buildQuery({ name: 'Hotel Sai', area: 'Kothrud', address: '12 Paud Road' });
  assert.match(q, /12 Paud Road/);
  assert.ok(!/Hotel Sai/.test(q), 'the name adds nothing once there is a street address');
});

// ── re-importing the same spreadsheet ────────────────────────────────────────

test('the same row always gets the same id, however it is typed', () => {
  const a = placeIdFor({ name: 'Hotel Sai', area: 'Kothrud' });
  for (const variant of ['hotel sai', 'HOTEL  SAI', ' Hotel, Sai ', 'Hotel-Sai']) {
    assert.equal(placeIdFor({ name: variant, area: 'kothrud' }), a, `"${variant}" must match`);
  }
});

test('different restaurants keep different ids', () => {
  const sai = placeIdFor({ name: 'Sai Restaurant', area: 'Kothrud' });
  assert.notEqual(sai, placeIdFor({ name: 'Sai Palace', area: 'Kothrud' }));
  // The same name in another area is another restaurant.
  assert.notEqual(sai, placeIdFor({ name: 'Sai Restaurant', area: 'Baner' }));
});

test('an external id wins, so a rename does not create a second row', () => {
  const before = placeIdFor({ externalId: 'R-100', name: 'Hotel Sai', area: 'Kothrud' });
  const after = placeIdFor({ externalId: 'R-100', name: 'Sai Grand', area: 'Kothrud' });
  assert.equal(before, after);
  assert.match(before, /^ext_/);
});

test('an id is always a legal Firestore document id', () => {
  for (const name of ['../../etc/passwd', 'a/b', '.', '..', '“smart quotes”', 'x'.repeat(500)]) {
    const id = placeIdFor({ name, area: null });
    assert.match(id, /^[A-Za-z0-9_-]+$/, `"${name}" produced an unusable id`);
    assert.ok(id.length > 0 && id.length < 100);
    assert.ok(id !== '.' && id !== '..');
  }
});

test('normalising keeps words apart rather than collapsing them', () => {
  assert.equal(normalise('  Hotel   Sai  '), 'hotel sai');
  assert.equal(normalise('Tea & Snacks'), 'tea and snacks');
  assert.notEqual(normalise('Sai Restaurant'), normalise('Sairestaurant'));
});
