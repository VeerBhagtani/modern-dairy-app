// Every restaurant's pin, confirmed with Google Maps.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'backend', 'x.cjs'));
const { verdictFor, needsCheck, STATUS, CONFIRM_RADIUS_M } = require_(path.join(ROOT, 'backend/src/services/googleCheck.js'));
const { MATCH } = require_(path.join(ROOT, 'backend/src/services/places.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PIN = { name: 'Hotel Sai Palace', lat: 18.5204, lng: 73.8567 };
const north = (m) => ({ lat: PIN.lat + m / 111320, lng: PIN.lng });
const hit = (match, at, name = 'Hotel Sai Palace') => ({
  match, point: { ...at, displayName: name, formattedAddress: 'FC Road, Pune', placeId: 'ChIJ123' },
});

test('Google has the business, by name, at the pin: confirmed', () => {
  const v = verdictFor(PIN, hit(MATCH.STRONG, north(40)));
  assert.equal(v.status, STATUS.CONFIRMED);
  assert.ok(Math.abs(v.distanceM - 40) <= 2, `distance ${v.distanceM}`);
});

test('Google has the business, by name, somewhere else: the pin is probably wrong', () => {
  const v = verdictFor(PIN, hit(MATCH.STRONG, north(900)));
  assert.equal(v.status, STATUS.MOVED);
  assert.ok(Math.abs(v.distanceM - 900) <= 3, `distance ${v.distanceM}`);
  // Google's own position is kept, so the office can move the pin in one tap.
  assert.ok(Number.isFinite(v.googleLat) && Number.isFinite(v.googleLng));
});

test('the confirm radius is wider than a geofence but not a neighbourhood', () => {
  assert.equal(verdictFor(PIN, hit(MATCH.STRONG, north(CONFIRM_RADIUS_M - 5))).status, STATUS.CONFIRMED);
  assert.equal(verdictFor(PIN, hit(MATCH.STRONG, north(CONFIRM_RADIUS_M + 30))).status, STATUS.MOVED);
});

test('another name right at the pin is flagged for a person, not accepted', () => {
  const v = verdictFor(PIN, hit(MATCH.WEAK, north(20), 'Sai Restaurant'));
  assert.equal(v.status, STATUS.NAME_DIFFERS);
  assert.match(v.detail, /Sai Restaurant/);
});

test('another name somewhere else is not a confirmation of anything', () => {
  assert.equal(verdictFor(PIN, hit(MATCH.WEAK, north(700), 'Some Other Cafe')).status, STATUS.NOT_FOUND);
  assert.equal(verdictFor(PIN, null).status, STATUS.NOT_FOUND);
  assert.equal(verdictFor(PIN, { match: MATCH.NONE, point: null }).status, STATUS.NOT_FOUND);
});

test('which restaurants need a check', () => {
  const checked = { ...PIN, googleCheck: { status: 'confirmed', at: 1000, pinLat: PIN.lat, pinLng: PIN.lng } };
  assert.equal(needsCheck({ ...PIN }), true, 'never checked');
  assert.equal(needsCheck(checked), false, 'checked, pin unchanged');
  assert.equal(needsCheck({ ...checked, lat: PIN.lat + 0.001 }), true, 'the pin moved since');
  assert.equal(needsCheck(checked, { before: 2000 }), true, 'a re-check run started after it');
  assert.equal(needsCheck(checked, { before: 500 }), false, 'checked during the run already');
  assert.equal(needsCheck({ name: 'No pin' }), false, 'nothing to check without a pin');
  assert.equal(needsCheck({ ...PIN, mobile: true }), false, 'food trucks have no fixed place');
  assert.equal(needsCheck({ ...PIN, active: false }), false, 'former customers are left alone');
});

test('the check never moves a pin by itself; the office does, and it is audited', () => {
  const admin = read('backend/src/routes/admin.js');
  const run = admin.slice(admin.indexOf("router.post('/restaurants/google-check'"), admin.indexOf('function googlePinUpdate'));
  assert.doesNotMatch(run, /\blat: /, 'the batch check writes only its verdict');
  const use = admin.slice(admin.indexOf("router.post('/restaurants/:id/use-google-pin'"));
  assert.match(use, /action: 'restaurants\.use_google_pin'/);
});

test('a re-check run uses the server\'s clock, so it always finishes', () => {
  const admin = read('backend/src/routes/admin.js');
  assert.match(admin, /req\.body\?\.recheck === true \? Date\.now\(\)/);
  assert.match(read('dashboard/views.js'), /if \(recheck\) run = r\.recheckBefore;/);
});

