// The Excel sheet against Google Maps: two lookups that do not know about
// each other, compared.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'backend', 'x.cjs'));
const sheet = require_(path.join(ROOT, 'backend/src/services/sheetCheck.js'));
const { MATCH } = require_(path.join(ROOT, 'backend/src/services/places.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ROW = { name: 'Hotel Sai Palace', address: '12 FC Road, Shivajinagar', area: 'Shivajinagar', lat: 18.52, lng: 73.84 };
const at = (lat, lng, extra = {}) => ({ lat, lng, formattedAddress: 'FC Road, Pune', placeId: 'ChIJ1', displayName: 'Hotel Sai Palace', ...extra });
const north = (p, m) => ({ lat: p.lat + m / 111320, lng: p.lng });
const addr = (p, confidence = 'EXACT') => ({ confidence, point: at(p.lat, p.lng) });
const found = (...c) => ({ candidates: c });

test('Google has the restaurant near the sheet address: match', () => {
  const A = { lat: 18.5205, lng: 73.8410 };
  const v = sheet.verdictFor(ROW, addr(A), found({ point: at(north(A, 120).lat, A.lng), match: MATCH.STRONG }));
  assert.equal(v.status, sheet.STATUS.MATCH);
  assert.ok(Math.abs(v.apartM - 120) <= 2);
  assert.equal(v.inputKey, sheet.inputKey(ROW));
});

test('Google has it far from the sheet address: does not match', () => {
  const A = { lat: 18.5205, lng: 73.8410 };
  const v = sheet.verdictFor(ROW, addr(A), found({ point: at(north(A, 3000).lat, A.lng), match: MATCH.STRONG }));
  assert.equal(v.status, sheet.STATUS.FAR);
  assert.ok(v.apartM > 2900);
});

test('how close counts depends on how precise the sheet address is', () => {
  const A = { lat: 18.5205, lng: 73.8410 };
  const g = found({ point: at(north(A, 1200).lat, A.lng), match: MATCH.STRONG });
  assert.equal(sheet.verdictFor(ROW, addr(A, 'EXACT'), g).status, 'far', 'a building address is held tight');
  assert.equal(sheet.verdictFor(ROW, addr(A, 'AREA_ONLY'), g).status, 'match', 'an area-only address gets room');
});

test('a chain is compared by its branch nearest the sheet address', () => {
  const A = { lat: 18.5205, lng: 73.8410 };
  const v = sheet.verdictFor(ROW, addr(A), found(
    { point: at(north(A, 6000).lat, A.lng, { placeId: 'far' }), match: MATCH.STRONG },
    { point: at(north(A, 90).lat, A.lng, { placeId: 'near' }), match: MATCH.STRONG },
  ));
  assert.equal(v.status, 'match');
  assert.equal(v.googlePlaceId, 'near');
  assert.equal(v.branches, 2);
});

test('a same-name business wins over one that shares only part of the name', () => {
  const A = { lat: 18.5205, lng: 73.8410 };
  const v = sheet.verdictFor(ROW, addr(A), found(
    { point: at(north(A, 30).lat, A.lng, { displayName: 'Sai Snacks', placeId: 'partial' }), match: MATCH.WEAK },
    { point: at(north(A, 4000).lat, A.lng, { placeId: 'same' }), match: MATCH.STRONG },
  ));
  assert.equal(v.googlePlaceId, 'same');
  assert.equal(v.status, 'far');
  assert.equal(v.nameMatch, 'same');
});

test('no business by this name, or no address: said so, never called a match', () => {
  const A = { lat: 18.5205, lng: 73.8410 };
  const nb = sheet.verdictFor(ROW, addr(A), found({ point: at(A.lat, A.lng, { displayName: 'Other Cafe' }), match: MATCH.NONE }));
  assert.equal(nb.status, 'no_business');
  assert.match(nb.detail, /Other Cafe/);
  const na = sheet.verdictFor({ name: 'Hotel Sai Palace' }, null, found({ point: at(A.lat, A.lng), match: MATCH.STRONG }));
  assert.equal(na.status, 'no_address');
  assert.match(na.detail, /no address/);
});

test('the two lookups are independent: no address in the name search, no name in the address search', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes('geocode')) {
      return { ok: true, json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 18.5205, lng: 73.841 }, location_type: 'ROOFTOP' }, formatted_address: 'FC Road' }] }) };
    }
    return { ok: true, json: async () => ({ places: [{ id: 'x', displayName: { text: 'Hotel Sai Palace' }, formattedAddress: 'FC Road', location: { latitude: 18.5206, longitude: 73.841 } }] }) };
  };
  const v = await sheet.checkOne(ROW, 'KEY', { fetchImpl });
  assert.equal(v.status, 'match');
  const g = calls.find((c) => c.url.includes('geocode'));
  const p = calls.find((c) => c.url.includes('places'));
  assert.doesNotMatch(decodeURIComponent(g.url), /Sai Palace/, 'the address lookup does not know the name');
  assert.doesNotMatch(p.body.textQuery, /FC Road|Shivajinagar/, 'the name lookup does not know the address');
  assert.match(p.body.textQuery, /Hotel Sai Palace, Pune/);
});

test('which rows need checking', () => {
  const done = { ...ROW, sheetCheck: { status: 'match', at: 1000, inputKey: sheet.inputKey(ROW) } };
  assert.equal(sheet.needsCheck(ROW), true);
  assert.equal(sheet.needsCheck(done), false);
  assert.equal(sheet.needsCheck({ ...done, address: '99 MG Road' }), true, 'the sheet row changed');
  assert.equal(sheet.needsCheck(done, { before: 2000 }), true, 'a re-check run');
  assert.equal(sheet.needsCheck({ ...ROW, mobile: true }), false);
  assert.equal(sheet.needsCheck({ ...ROW, active: false }), false);
  assert.equal(sheet.needsCheck({ ...ROW, lat: undefined, lng: undefined }), true, 'no pin still gets checked');
});

test('the check never moves a pin; "fix all" moves only where sheet and Google agree, audited, lock respected', () => {
  const admin = read('backend/src/routes/admin.js');
  const run = admin.slice(admin.indexOf("router.post('/restaurants/sheet-check'"), admin.indexOf('function googlePinUpdate'));
  assert.doesNotMatch(run, /\blat: /);
  assert.match(run, /sheetCheck: verdict/);
  const bulk = admin.slice(admin.indexOf("router.post('/restaurants/use-google-pins'"), admin.indexOf("router.get('/restaurants/export.csv'"));
  assert.match(bulk, /if \(await refuseIfLocked\(req, res\)\) return;/);
  assert.match(bulk, /c\.status === sheetCheck\.STATUS\.MATCH/);
  assert.match(bulk, /c\.inputKey === sheetCheck\.inputKey\(before\)/);
  assert.match(bulk, /> PIN_OFF_M/);
  assert.match(bulk, /action: 'restaurants\.use_google_pin'/);
});

test('the dashboard shows both positions with Google Maps links, filters, and downloads every row', () => {
  const views = read('dashboard/views.js');
  assert.match(views, /function renderSheetResults\(\)/);
  assert.match(views, /query=' \+ \(\+lat\)\.toFixed\(6\)/);
  assert.match(views, /query_place_id=/);
  assert.match(views, /API\.useGooglePins\(fixIds\)/);
  assert.match(views, /excel-vs-google-maps\.csv/);
  assert.match(views, /Address in the Excel sheet/);
  // The dashboard's staleness key matches the server's.
  assert.match(views, /\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.toLowerCase\(\); \}\)\.join\('\|'\)/);
  assert.match(read('dashboard/api.js'), /sheetCheck: function \(run\)/);
});
