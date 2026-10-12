// Days and rides.
//
// A ride belongs to the day it started (IST). It is NOT cut at midnight: a
// driver who leaves at 7:30 PM is recorded until the office closes the ride
// next morning. A new ride closes an older day's ride that is still open, and
// a ride nobody stops is closed after autoStopAfterHours.
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

test('a ride is not closed at midnight: it runs until the office stops it', () => {
  // A 7:30 PM round is closed by the office at reporting time next morning.
  const fn = REPO.slice(REPO.indexOf('async function closeIfDayOver'), REPO.indexOf('async function closeAtDayEnd'));
  assert.match(fn, /return null;/);
  assert.doesNotMatch(fn, /stopRide\(/);
});

test('Start Ride for a new ride closes an older day\'s open ride at that moment, not at its midnight', () => {
  const fn = REPO.slice(REPO.indexOf('async function startRide'), REPO.indexOf('// The only way a ride stops.'));
  assert.match(fn, /const current = open\.find\(\(d\) => \(d\.data\(\)\.dayKey \|\| today\) >= today\);/);
  assert.match(fn, /for \(const d of open\) if \(d !== current\) closeOld\(d\.ref, d\.data\(\)\);/);
  assert.match(fn, /stoppedAt: Math\.max\(data\.startedAt \|\| 0, now\)/, 'the night\'s fixes stay in it');
});

test('the dashboard shows a ride running since last night, and one the office closed this morning', () => {
  const adm = read('backend/src/routes/admin.js');
  assert.match(adm, /const rides = todays\.concat\(earlier, closedToday\);/);
  assert.match(adm, /\(r\.stoppedAt \|\| 0\) >= todayStart/);
});

test('safety net: a ride nobody stops is closed after a full day, and flagged before that', () => {
  const cfg = read('backend/src/drivers/config.js');
  assert.match(cfg, /autoStopAfterHours: 24,/);
  assert.match(cfg, /longRideAlertHours: 16,/);
});
