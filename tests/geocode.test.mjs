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

test('a line break in an address does not end up in the query', () => {
  // Real rows from the office's own export contain CRLF inside the address.
  const q = geo.buildQuery({ name: 'X', address: '32/A, HADAPSAR ESTATE\r\n,Pune  ,  Maharashtra' });
  assert.ok(!/[\r\n]/.test(q), 'the query must be one line');
  assert.ok(!/\s{2,}/.test(q), 'and must not carry runs of spaces');
});

test('an address is preferred over a name, because it is worth far more', () => {
  const q = geo.buildQuery({ name: 'Hotel Sai', area: 'Kothrud', address: '12 Paud Road' });
  assert.match(q, /12 Paud Road/);
  assert.ok(!/Hotel Sai/.test(q), 'the name adds nothing once there is a street address');
});

// ── what may be placed without a person looking ──────────────────────────────
//
// Three thousand restaurants cannot be placed by hand, so this rule had to
// widen past "rooftop only". These tests pin exactly how far it widened — and,
// more importantly, what it still refuses.

test('a street-level match from a real address is placed', () => {
  // The office's own spreadsheet has rows like "32/A, Hadapsar Industrial
  // Estate". Landing on that road is tens of metres out, and a driver standing
  // on it is genuinely at that customer.
  assert.ok(geo.canAutoPlace(
    { confidence: geo.CONFIDENCE.APPROXIMATE, alternatives: 0 },
    { hasStreetAddress: true },
  ));
});

test('the same match from a name and an area alone is not', () => {
  // "Hotel Sai, Kothrud" landing on some road is a shrug, not an address.
  assert.ok(!geo.canAutoPlace(
    { confidence: geo.CONFIDENCE.APPROXIMATE, alternatives: 0 },
    { hasStreetAddress: false },
  ));
});

test('the centre of a suburb is never placed, address or no address', () => {
  // The rule that must never widen. A suburb centroid is kilometres across, and
  // accepting one turns every private errand through Kothrud into billable
  // distance. No combination of inputs may let it through.
  for (const hasStreetAddress of [true, false]) {
    for (const alternatives of [0, 3]) {
      assert.ok(!geo.canAutoPlace(
        { confidence: geo.CONFIDENCE.AREA_ONLY, alternatives },
        { hasStreetAddress },
      ), 'AREA_ONLY must never be placed automatically');
    }
  }
  assert.ok(!geo.canAutoPlace({ confidence: geo.CONFIDENCE.NONE }, { hasStreetAddress: true }));
  assert.ok(!geo.canAutoPlace(undefined, undefined));
});

test('an ambiguous street-level match still goes to a person', () => {
  // Two candidates means the geocoder does not know which restaurant this is,
  // and having an address does not settle that.
  assert.ok(!geo.canAutoPlace(
    { confidence: geo.CONFIDENCE.APPROXIMATE, alternatives: 1 },
    { hasStreetAddress: true },
  ));
});

test('a rooftop match is placed whatever the spreadsheet gave', () => {
  assert.ok(geo.canAutoPlace({ confidence: geo.CONFIDENCE.EXACT, alternatives: 0 }, { hasStreetAddress: false }));
});

test('an area name is not mistaken for a street address', () => {
  for (const good of [
    '32/A, Hadapsar Industrial Estate, Pune',
    'Shop 4, Paud Road, Kothrud',
    '1204 Sadashiv Peth, Near Tilak Road',
  ]) assert.ok(geo.looksLikeStreetAddress(good), `"${good}" should count as an address`);

  for (const bad of ['Kothrud', 'Baner', '', null, undefined, 'Pune', 'Camp area', '411038']) {
    assert.ok(!geo.looksLikeStreetAddress(bad), `"${bad}" should not count as an address`);
  }
});

test('a lookup reports autoPlace using the address it was given', async () => {
  const body = {
    status: 'OK',
    results: [{
      geometry: { location: { lat: 18.5, lng: 73.8 }, location_type: 'GEOMETRIC_CENTER' },
      formatted_address: 'Hadapsar Industrial Estate Rd, Pune',
    }],
  };
  const fetchImpl = async () => ({ ok: true, json: async () => body });

  const withAddress = await geo.geocodeOne('q', 'key', { fetchImpl, hasStreetAddress: true });
  assert.equal(withAddress.confidence, geo.CONFIDENCE.APPROXIMATE);
  assert.equal(withAddress.autoPlace, true);

  const without = await geo.geocodeOne('q', 'key', { fetchImpl });
  assert.equal(without.autoPlace, false, 'no address means no automatic placement');
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
