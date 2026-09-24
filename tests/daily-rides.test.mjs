// One ride per day.
//
// Only the office stops a ride, and nobody stops every ride every evening, so
// rides ran on for days: Start Ride the next morning returned the same ride,
// and a week of driving became one ride with one total. A ride now ends with
// its day, at the end of that day.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const require_ = Module.createRequire(path.join(ROOT, 'backend', 'x.cjs'));

// repo.js connects to Firestore when loaded; these helpers are pure, so they
// are evaluated straight from the source rather than through the module.
const REPO = read('backend/src/services/repo.js');
const pick = (name) => {
  const line = REPO.split('\n').find((l) => l.startsWith(`const ${name} = `));
  // eslint-disable-next-line no-new-func
  return new Function(`${line}\nreturn ${name};`)();
};
const dayKeyFor = pick('dayKeyFor');
const endOfDayMs = pick('endOfDayMs');

test('days are Indian days, not UTC days', () => {
  // 00:30 IST on the 25th is still the 24th in UTC.
  assert.equal(dayKeyFor(Date.parse('2026-09-25T00:30:00+05:30')), '2026-09-25');
  assert.equal(dayKeyFor(Date.parse('2026-09-24T23:59:00+05:30')), '2026-09-24');
});

test('a day ends at the last millisecond before IST midnight', () => {
  const end = endOfDayMs('2026-09-24');
  assert.equal(dayKeyFor(end), '2026-09-24');
  assert.equal(dayKeyFor(end + 1), '2026-09-25');
});

test('a ride from an earlier day is closed at the end of ITS day, not when noticed', () => {
  // So its points up to midnight stay in it, and later ones are refused from
  // it rather than being counted as that day's driving.
  const fn = REPO.slice(REPO.indexOf('async function closeIfDayOver'), REPO.indexOf('async function', REPO.indexOf('async function closeIfDayOver') + 10));
  assert.match(fn, /if \(ride\.dayKey >= dayKeyFor\(nowMs\)\) return null;/);
  assert.match(fn, /stoppedAt: Math\.min\(nowMs, endOfDayMs\(ride\.dayKey\)\)/);
  assert.match(fn, /kind: 'day_end'/);
});

test('Start Ride on a new day closes the old ride and starts a new one', () => {
  const fn = REPO.slice(REPO.indexOf('async function startRide'), REPO.indexOf('// The only way a ride stops.'));
  assert.match(fn, /const current = open\.find\(\(d\) => \(d\.data\(\)\.dayKey \|\| today\) >= today\);/,
    'only a ride from today is carried on');
  assert.match(fn, /for \(const d of open\) if \(d !== current\) closeOld\(d\.ref, d\.data\(\)\);/);
});

test('every path that touches a running ride closes a finished day first', () => {
  const drv = read('backend/src/routes/driver.js');
  const active = drv.slice(drv.indexOf("router.get('/rides/active'"), drv.indexOf("router.post('/rides/:rideId/points'"));
  assert.match(active, /repo\.closeIfDayOver\(ride\)/, 'the phone checking its ride');
  const points = drv.slice(drv.indexOf("router.post('/rides/:rideId/points'"));
  assert.match(points, /repo\.closeIfDayOver\(ride\)/, 'the phone uploading');
  assert.match(read('backend/src/services/rideProcessing.js'), /repo\.closeIfDayOver\(ride, nowMs\)/, 'housekeeping');
  assert.match(read('backend/src/routes/admin.js'), /await repo\.closeIfDayOver\(r, now\);/, 'the dashboard');
});

test('today\'s dashboard figures count today\'s rides only', () => {
  const adm = read('backend/src/routes/admin.js');
  assert.match(adm, /const rides = todays;/);
});

test('a day-end close says so, and is not presented as the office stopping anyone', () => {
  const app = read('app/www/app.js');
  assert.match(app, /state\.stoppedInfo\.kind === 'day_end'/);
  assert.match(app, /Each day is its own ride\. Press Start Ride to begin today\./);
  const drv = read('backend/src/routes/driver.js');
  assert.match(drv, /recorded after this ride\\'s day ended/);
});
