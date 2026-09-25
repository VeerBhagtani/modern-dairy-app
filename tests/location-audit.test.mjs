// Phase 1: every restaurant's stored location against Google Maps.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'backend', 'x.cjs'));
const audit = require_(path.join(ROOT, 'backend/src/services/locationAudit.js'));
const names = require_(path.join(ROOT, 'backend/src/services/nameMatch.js'));
const { pinChange } = require_(path.join(ROOT, 'backend/src/services/pinHistory.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PIN = { lat: 18.5204, lng: 73.8567 };
const off = (p, north, east = 0) => ({ lat: p.lat + north / 111320, lng: p.lng + east / (111320 * Math.cos(p.lat * Math.PI / 180)) });
const place = (name, at, extra = {}) => ({ id: 'id' + name + at.lat.toFixed(6) + at.lng.toFixed(6), name, displayName: { text: name }, formattedAddress: extra.address || 'Pune, Maharashtra',
  location: { latitude: at.lat, longitude: at.lng }, nationalPhoneNumber: extra.phone, types: ['restaurant'] });

/* A fake Google: answers each kind of request from a table, and records them. */
function fakeGoogle({ fullText = [], shortText = [], nearby = [], address = null }) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ u, body, mask: opts && opts.headers && opts.headers['X-Goog-FieldMask'] });
    if (u.includes('geocode')) {
      return { ok: true, json: async () => (address
        ? { status: 'OK', results: [{ geometry: { location: address, location_type: address.type || 'ROOFTOP' }, formatted_address: 'addr' }] }
        : { status: 'ZERO_RESULTS', results: [] }) };
    }
    if (u.includes('searchNearby')) return { ok: true, json: async () => ({ places: nearby }) };
    const isFirst = calls.filter((c) => c.u.includes('searchText')).length === 1;
    return { ok: true, json: async () => ({ places: isFirst ? fullText : shortText }) };
  };
  return { fetchImpl, calls };
}
const run = (row, g) => audit.auditOne(row, 'KEY', { fetchImpl: g.fetchImpl, nowMs: 1000 });

// ── names ──────────────────────────────────────────────────────────────
test('different names for the same business are recognised', () => {
  assert.equal(names.compare('Hotel ABC', 'ABC Family Restaurant & Bar').level, 'strong');
  assert.equal(names.compare('Vaishali', 'Vaishaali Restaurant').level, 'strong');
  assert.equal(names.compare('Hotel Rupali', 'Roopali Pure Veg').level, 'strong');
  assert.equal(names.compare('Sainath Snacks', 'Sai Nath').level, 'strong');
});
test('a strong name 400 m from our pin with nothing else to support it is not HIGH', async () => {
  const v = await run({ name: 'Hotel ABC', ...PIN }, fakeGoogle({ fullText: [place('ABC Restaurant', off(PIN, 400))] }));
  assert.equal(v.confidence, 'MEDIUM');
  assert.equal(v.status, 'NEEDS_MANUAL_REVIEW');
});
test('a match only on common words is not treated as proof', () => {
  assert.equal(names.compare('Shree Ganesh Hotel', 'Ganesh Pure Veg Restaurant').level, 'common');
  assert.equal(names.compare('Sai Palace', 'Sai Garden').level, 'common');
  assert.equal(names.compare('Hotel Kalinga', 'Hotel Shreyas').level, 'none');
});

// ── verdicts ───────────────────────────────────────────────────────────
test('same business within 50 m of our pin: VERIFIED, HIGH, keep', async () => {
  const g = fakeGoogle({ fullText: [place('ABC Family Restaurant & Bar', off(PIN, 30))] });
  const v = await run({ name: 'Hotel ABC', area: 'Deccan', ...PIN }, g);
  assert.equal(v.status, 'VERIFIED');
  assert.equal(v.confidence, 'HIGH');
  assert.match(v.action, /Keep the existing location/);
  assert.equal(v.found.name, 'ABC Family Restaurant & Bar');
  assert.ok(Math.abs(v.distanceM - 30) <= 2);
  assert.deepEqual(v.searches.filter((s) => s !== 'address'), ['name_address'], 'a confident first answer stops the search');
});

test('50–100 m: MINOR_DIFFERENCE; beyond 100 m: SIGNIFICANT_DIFFERENCE with a move recommended', async () => {
  let v = await run({ name: 'Hotel ABC', ...PIN }, fakeGoogle({ fullText: [place('ABC Restaurant', off(PIN, 80))] }));
  assert.equal(v.status, 'MINOR_DIFFERENCE');
  v = await run({ name: 'Hotel ABC', ...PIN }, fakeGoogle({ fullText: [place('ABC Restaurant', off(PIN, 240))] }));
  assert.equal(v.status, 'SIGNIFICANT_DIFFERENCE');
  assert.equal(v.confidence, 'HIGH');
  assert.match(v.action, /Move to Google/);
});

test('name differs on Google: found by the shortened name, judged on evidence', async () => {
  const g = fakeGoogle({ fullText: [], shortText: [place('Ganesh Pure Veg Restaurant', off(PIN, 40))] });
  const v = await run({ name: 'Shree Ganesh Hotel', area: 'Kothrud', ...PIN }, g);
  assert.ok(v.searches.includes('short_name'));
  assert.equal(g.calls.find((c) => c.u.includes('searchText') && c.body.textQuery.startsWith('ganesh')).body.textQuery, 'ganesh, Kothrud, Pune');
  assert.equal(v.found.name, 'Ganesh Pure Veg Restaurant');
  assert.equal(v.confidence, 'MEDIUM', 'a common name near the pin is plausible, not proven');
  assert.equal(v.status, 'VERIFIED');
});

test('a common name far from our pin and address is never matched', async () => {
  const g = fakeGoogle({ fullText: [place('Ganesh Pure Veg Restaurant', off(PIN, 5000))] });
  const v = await run({ name: 'Shree Ganesh Hotel', area: 'Kothrud', ...PIN }, g);
  assert.equal(v.status, 'NEEDS_MANUAL_REVIEW');
  assert.equal(v.confidence, 'LOW');
});

test('not found by name: the businesses around our pin are searched', async () => {
  const g = fakeGoogle({ nearby: [place('Mauli Misal House', off(PIN, 25)), place('Some Tailor', off(PIN, 10))] });
  const v = await run({ name: 'Mauli Misal', area: 'Hadapsar', ...PIN }, g);
  assert.ok(v.searches.includes('nearby'));
  assert.equal(g.calls.find((c) => c.u.includes('searchNearby')).body.locationRestriction.circle.radius, audit.NEARBY_M);
  assert.equal(v.found.name, 'Mauli Misal House');
  assert.equal(v.found.via, 'nearby');
  assert.equal(v.status, 'VERIFIED');
});

test('nothing on Google by name or nearby: NOT_FOUND, no location invented', async () => {
  const v = await run({ name: 'Anand Caterers Kiosk', ...PIN }, fakeGoogle({ nearby: [place('City Tailors', off(PIN, 20))] }));
  assert.equal(v.status, 'NOT_FOUND');
  assert.equal(v.found, null);
  assert.equal(v.distanceM, null);
});

test('two equally good businesses far apart: NEEDS_MANUAL_REVIEW', async () => {
  const g = fakeGoogle({ fullText: [place('Wadeshwar Cafe', off(PIN, 2000)), place('Wadeshwar Cafe', off(PIN, -2000))] });
  const v = await run({ name: 'Wadeshwar', ...PIN }, g);
  assert.equal(v.status, 'NEEDS_MANUAL_REVIEW');
  assert.match(v.reason, /Two businesses fit equally well/);
});

test('the same phone number is decisive, and phone fields are asked for only when we have one', async () => {
  let g = fakeGoogle({ fullText: [place('Pooja Snacks Centre', off(PIN, 400), { phone: '098220 12345' })] });
  let v = await run({ name: 'Pooja', phone: '+91 9822012345', ...PIN }, g);
  assert.equal(v.confidence, 'HIGH');
  assert.equal(v.found.phoneMatch, true);
  assert.match(g.calls.find((c) => c.u.includes('searchText')).mask, /nationalPhoneNumber/);
  g = fakeGoogle({ fullText: [place('Pooja Snacks', off(PIN, 20))] });
  v = await run({ name: 'Pooja', ...PIN }, g);
  assert.doesNotMatch(g.calls.find((c) => c.u.includes('searchText')).mask, /PhoneNumber/);
});

test('a suburb-centre pin (the ~90 accepted by area) is not "verified" by being near something', async () => {
  const g = fakeGoogle({ fullText: [place('Hotel Kalinga', off(PIN, 1800), { address: 'Karve Rd, Kothrud, Pune' })] });
  const v = await run({ name: 'Kalinga', area: 'Kothrud', locationSource: 'accepted_in_bulk_AREA_ONLY', ...PIN }, g);
  assert.equal(v.storedIsSuburb, true);
  assert.equal(v.status, 'SIGNIFICANT_DIFFERENCE');
  assert.match(v.reason, /only the centre of the suburb/);
  assert.match(v.action, /Move to Google/);
  assert.ok(!v.searches.includes('nearby'), 'the area around a suburb centre says nothing about the shop');
});

test('a pin the office placed by hand is not recommended for moving without a look', async () => {
  const v = await run({ name: 'Hotel ABC', locationSource: 'office', ...PIN }, fakeGoogle({ fullText: [place('ABC Restaurant', off(PIN, 300))] }));
  assert.equal(v.status, 'SIGNIFICANT_DIFFERENCE');
  assert.match(v.action, /placed this pin by hand/);
  assert.equal(audit.bulkApplicable({ name: 'Hotel ABC', locationSource: 'office', ...PIN, locationAudit: v }), false);
});

test('the Excel address disagreeing lowers confidence', async () => {
  const g = fakeGoogle({ fullText: [place('ABC Restaurant', off(PIN, 250))], address: { ...off(PIN, 6000), type: 'ROOFTOP' } });
  const v = await run({ name: 'Hotel ABC', address: '5 MG Road', ...PIN }, g);
  assert.equal(v.confidence, 'MEDIUM');
  assert.equal(v.status, 'NEEDS_MANUAL_REVIEW');
  assert.match(v.reason, /sheet's address is/);
});

test('staleness: a moved pin or an edited sheet row needs a new audit', async () => {
  const row = { name: 'Hotel ABC', area: 'Deccan', ...PIN };
  const v = await run(row, fakeGoogle({ fullText: [place('ABC', off(PIN, 10))] }));
  const done = { ...row, locationAudit: v };
  assert.equal(audit.needsAudit(done), false);
  assert.equal(audit.needsAudit({ ...done, lat: PIN.lat + 0.001 }), true);
  assert.equal(audit.needsAudit({ ...done, area: 'Kothrud' }), true);
  assert.equal(audit.needsAudit(done, { before: 2000 }), true);
  assert.equal(audit.needsAudit({ ...done, mobile: true }), false);
});

test('bulk apply only takes HIGH-confidence significant differences', async () => {
  const row = { name: 'Hotel ABC', area: 'Deccan', ...PIN };
  const far = await run(row, fakeGoogle({ fullText: [place('ABC Restaurant', off(PIN, 400), { address: 'FC Rd, Deccan, Pune' })] }));
  assert.equal(audit.bulkApplicable({ ...row, locationAudit: far }), true);
  const near = await run(row, fakeGoogle({ fullText: [place('ABC Restaurant', off(PIN, 20))] }));
  assert.equal(audit.bulkApplicable({ ...row, locationAudit: near }), false);
  assert.equal(audit.bulkApplicable({ ...row, lat: PIN.lat + 0.01, locationAudit: far }), false, 'stale');
});

// ── the trail ──────────────────────────────────────────────────────────
test('every pin move keeps the original, the source, who, why and the verification', () => {
  const before = { lat: 1, lng: 2, locationSource: 'places' };
  const { fields, entry } = pinChange(before, { lat: 3, lng: 4, source: 'google_places', by: 'admin:a1', reason: 'audit', verification: { status: 'SIGNIFICANT_DIFFERENCE' } }, 99);
  assert.deepEqual(fields.originalLocation, { lat: 1, lng: 2, source: 'places', keptAt: 99 });
  assert.deepEqual(entry.from, { lat: 1, lng: 2, source: 'places' });
  assert.deepEqual(entry.to, { lat: 3, lng: 4, source: 'google_places' });
  assert.equal(entry.by, 'admin:a1');
  assert.equal(entry.verification.status, 'SIGNIFICANT_DIFFERENCE');
  const again = pinChange({ ...before, ...fields }, { lat: 5, lng: 6, source: 'office', by: 'admin:a2', reason: 'fix' }, 100);
  assert.equal(again.fields.originalLocation, undefined, 'the original is kept once, never overwritten');
  assert.throws(() => pinChange(before, { lat: 1, lng: 2, source: 'x', by: 'y' }), /reason/);
});

test('no route writes a restaurant pin without going through pinChange', () => {
  const admin = read('backend/src/routes/admin.js');
  // The old direct writes are gone: every pin write builds its fields with pinChange.
  assert.doesNotMatch(admin, /patch\.lat = /);
  assert.doesNotMatch(admin, /locationStatus: 'confirmed',\n\s+locationSource:/);
  assert.doesNotMatch(admin, /lat: c\.(?:lat|googleLat),\n\s+lng: c\.(?:lng|googleLng),\n\s+locationStatus/);
  const writes = (admin.match(/pinChange\(/g) || []).length;
  assert.ok(writes >= 7, 'pinChange used on every write path, found ' + writes);
  for (const route of ["router.post('/restaurants/:id/confirm-location'", "router.post('/restaurants/:id/apply-audit-location'",
    "router.post('/restaurants/apply-audit-locations'", "router.post('/restaurants/accept-candidates'"]) {
    const i = admin.indexOf(route);
    assert.ok(i !== -1, route);
    assert.match(admin.slice(i, admin.indexOf('\nrouter.', i + 10)), /pinChange\(|auditMove\(/, route + ' records history');
  }
});

test('re-importing the spreadsheet never overwrites a verified or hand-placed pin', () => {
  const admin = read('backend/src/routes/admin.js');
  const imp = admin.slice(admin.indexOf("router.post('/restaurants/import'"), admin.indexOf('// GET /admin/restaurants/awaiting-location'));
  assert.match(imp, /sheetLat: /, 'the sheet\'s own coordinates are kept as evidence');
  assert.match(imp, /if \(existingPin\.has\(id\)\)/);
});

test('the audit report has every column the office asked for', () => {
  const admin = read('backend/src/routes/admin.js');
  const rep = admin.slice(admin.indexOf("router.get('/restaurants/location-audit.csv'"));
  for (const col of ['Customer ID', 'Our name', 'Our latitude', 'Our longitude', 'Google name', 'Google latitude', 'Google longitude',
    'Distance (m)', 'Status', 'Confidence', 'Reason', 'Recommended action']) {
    assert.ok(rep.includes(`'${col}'`), col);
  }
});

test('marking a food truck keeps its pin in the history, and unmarking puts it back', () => {
  const { pinRemoval } = require_(path.join(ROOT, 'backend/src/services/pinHistory.js'));
  const { fields, entry } = pinRemoval({ lat: 1, lng: 2, locationSource: 'places' }, { by: 'admin:a', reason: 'truck' }, 5);
  assert.equal(fields.lat, null);
  assert.deepEqual(fields.removedPin, { lat: 1, lng: 2, source: 'places', at: 5, by: 'admin:a' });
  assert.deepEqual(entry.from, { lat: 1, lng: 2, source: 'places' });
  assert.equal(entry.to, null);
  const admin = read('backend/src/routes/admin.js');
  const mob = admin.slice(admin.indexOf("router.post('/restaurants/:id/mobile'"), admin.indexOf("router.post('/restaurants/:id/hold'"));
  assert.match(mob, /pinRemoval\(before/);
  assert.match(mob, /before\.removedPin\.lat/);
});

test('the dashboard: audit panel, results with both positions, apply buttons, report, history', () => {
  const views = read('dashboard/views.js');
  assert.match(views, /function renderAuditResults\(\)/);
  assert.match(views, /API\.applyAuditLocations\(fixIds\)/);
  assert.match(views, /API\.applyAuditLocation\(r\.p\.id, why\.trim\(\)\)/);
  assert.match(views, /function historySection\(place\)/);
  assert.match(views, /Suburb-centre pins/);
  assert.doesNotMatch(views, /sheetCheck|googleCheck|useGooglePin/);
  const api = read('dashboard/api.js');
  assert.match(api, /\/restaurants\/location-audit\.csv/);
  // The screen uses the server's staleness verdict, not its own copy.
  assert.match(read('backend/src/routes/admin.js'), /row\.auditCurrent = !locationAudit\.isStale\(row\)/);
});
