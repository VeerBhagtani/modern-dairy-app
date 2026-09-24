// A driver's history: one row per day, the same numbers on the office's
// History tab and on the driver's phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// history.js loads repo.js, which connects to Firestore; dayRow is pure, so it
// is evaluated from its source.
const SRC = read('backend/src/services/history.js');
const dayRow = new Function(`${SRC.slice(SRC.indexOf('const round1'), SRC.indexOf('/* @param driverId'))}; return dayRow;`)();

const result = (m, visits = []) => ({
  distance: { metres: { verifiedBusiness: 0, likelyBusiness: 0, personal: 0, unknown: 0, gapEstimate: 0, dayTotal: 0, ...m } },
  visits, review: { pending: 0 },
});

test('a day shows business as one figure, with its parts kept for the office', () => {
  const row = dayRow({ id: 'r1', dayKey: '2026-09-24', status: 'day_closed' },
    result({ verifiedBusiness: 4200, likelyBusiness: 12350, personal: 5400, dayTotal: 21950 }));
  assert.equal(row.km.business, 16.6);
  assert.equal(row.km.verifiedBusiness, 4.2);
  assert.equal(row.km.likelyBusiness, 12.4);
  assert.equal(row.km.personal, 5.4);
  assert.equal(row.km.total, 22.0);
});

test('each restaurant reached is listed once, in the order reached', () => {
  const row = dayRow({ id: 'r1' }, result({}, [
    { placeId: 'a', placeName: 'Hotel Sai', arrivedAt: 1 },
    { placeId: 'b', placeName: 'Vaishali', arrivedAt: 2 },
    { placeId: 'a', placeName: 'Hotel Sai', arrivedAt: 3 },
  ]));
  assert.deepEqual(row.restaurants.map((r) => r.name), ['Hotel Sai', 'Vaishali']);
});

test('a day not yet calculated says so, rather than showing zeros', () => {
  const row = dayRow({ id: 'r1', pointCount: 300 }, null);
  assert.equal(row.calculated, false);
  assert.equal(row.km, null);
});

test('a month\'s totals are added up in metres, not from rounded days', () => {
  // Thirty days of 0.44 km: adding the rounded 0.4s gives 12.0; the truth is 13.2.
  assert.match(SRC, /for \(const k of KEYS\) sumM\[k\] \+= d\.metres\[k\];/);
  assert.match(SRC, /round1\(sumM\[k\]\)/);
});

test('the phone can only ever see its own driver\'s history', () => {
  const drv = read('backend/src/routes/driver.js');
  const route = drv.slice(drv.indexOf("router.get('/history'"), drv.indexOf('// POST /driver/rides/:rideId/declare'));
  assert.match(route, /driverId: req\.driverId/, 'the driver comes from the token');
  assert.doesNotMatch(route, /req\.(query|body|params)\.driverId/, 'never from the request');
});

test('the office History tab and the phone both exist and use it', () => {
  assert.match(read('backend/src/routes/admin.js'), /router\.get\('\/history', requireRole\('viewer'\)/);
  assert.match(read('dashboard/views.js'), /\['history', 'History'\]/);
  assert.match(read('dashboard/api.js'), /history: function \(driverId, from, to\)/);
  assert.match(read('app/www/index.html'), /id="btnHistory"/);
  assert.match(read('app/www/app.js'), /apiFetch\('\/driver\/history\?days=30'\)/);
});
