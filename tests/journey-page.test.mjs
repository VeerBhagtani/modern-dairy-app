// The Journeys page: wired in, reachable from a driver and from a day, and
// fed by an endpoint that reads only the chosen driver's rides.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const views = read('dashboard/views.js');
const page = read('dashboard/journey.js');
const admin = read('backend/src/routes/admin.js');

test('a Journeys tab, opened by clicking a driver on Live fleet or a day in History', () => {
  assert.match(views, /\['journeys', 'Journeys'\]/);
  assert.match(views, /go\('journeys', \{ driverId: e\.currentTarget\.dataset\.driver, day: todayISO\(\) \}\)/);
  assert.match(views, /go\('journeys', \{ driverId: hist\.driverId, day: d \? d\.dayKey : todayISO\(\) \}\)/);
  assert.match(read('dashboard/index.html'), /<script src="journey\.js"><\/script>\s*<script src="views\.js">/);
  assert.doesNotMatch(page, /onclick=/, 'no inline handlers (the CSP forbids them)');
});

test('the page has the replay controls, the timeline and corrections', () => {
  for (const id of ['jPlay', 'jRestart', 'jSeek', 'jNow', 'jEvents']) assert.ok(page.includes(`id="${id}"`), id);
  assert.match(page, /var SPEEDS = \[\[1, 60\], \[2, 120\], \[5, 300\], \[10, 600\]\];/);
  assert.match(page, /API\.review\(s\.rideId, s\.segmentId, choice\[2\],/);
  assert.match(page, /setTimeout\(function \(\) \{\s*if \(!document\.getElementById\('jMap'\)\) return;\s*load\(true\);\s*\}, 30000\)/, 'a running ride refreshes by itself');
  assert.match(page, /if \(quiet && st\.playing\) \{ scheduleRefresh\(\); return; \}/, 'never yanks a replay');
  assert.match(page, /queuedPoints/, 'says when points are still on the phone');
});

test('the endpoint reads one driver, at most 7 days, and never drops a fix', () => {
  const ep = admin.slice(admin.indexOf("router.get('/journey'"), admin.indexOf("router.post('/rides/:rideId/process'"));
  assert.match(ep, /if \(!isValidId\(driverId\)\) return bad\(res, 'Choose a driver\.'\);/);
  assert.match(ep, /if \(to - from > 7 \* 864e5\) return bad\(res, 'Show at most 7 days at a time\.'\);/);
  assert.match(ep, /repo\.listRides\(\{ driverId, from, to, limit: 50 \}\)/);
  assert.match(ep, /const replay = buildReplay\(points, processing\);/);
  assert.doesNotMatch(ep, /points\.slice|filter\(\(p\) => p\.used\)/, 'every fix goes to the map; excluded ones are marked, not removed');
});

test('corrections can name the right restaurant, and are audited with before and after', () => {
  assert.match(admin, /const \{ toType, note, placeId \} = req\.body \|\| \{\};/);
  const repo = read('backend/src/services/repo.js');
  assert.match(repo, /before: \{ type: fromType, place: fromPlace \}, after: \{ type: toType, place: placeId \? \{ id: placeId, name: placeName \} : null, note \}/);
});
