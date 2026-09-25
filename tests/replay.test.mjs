// The route replay: drawn the way the kilometres were calculated.
//
// It used to draw every raw fix as one line, excluding only the first 2000
// bad fixes the processing document lists, so a bad-GPS day was drawn with
// spikes across Pune; GPS silences were drawn as roads; and nothing said which
// stretch was business and which personal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { fullDayJourney, FACILITIES, RESTAURANTS, PLACES } from './helpers/journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { buildReplay, segmentFor } = require('./src/services/replay');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const POINTS = Object.freeze(fullDayJourney({ seed: 2026, gapAfterWaypoint: 4, spikeAfterIndex: 60 }));
const NOW = POINTS[POINTS.length - 1].deviceTs + 60000;
const RIDE = { id: 'ride-replay', driverId: 'drv-replay', startedAt: POINTS[0].deviceTs };
const process_ = (points) => ({
  ...processRideData({
    points, ride: RIDE, facilities: FACILITIES, restaurants: RESTAURANTS,
    orders: [], declarations: [], reviews: [], nowMs: NOW,
  }),
  processedAt: NOW,
});

test('every fix is labelled with whether it counted, the same as the calculation', () => {
  const p = process_(POINTS.map((x) => ({ ...x })));
  const r = buildReplay(POINTS.map((x) => ({ ...x })), p);
  assert.equal(r.calculated, true);
  assert.equal(r.points.length, POINTS.length);
  assert.equal(r.points.filter((q) => !q.used).length, p.track.excludedPointCount);
  const spike = r.points.find((q) => q.ts === POINTS.find((x) => x.clientPointId.endsWith(':spike')).deviceTs && !q.used);
  assert.ok(spike, 'the injected spike is marked as not counted');
  assert.ok(spike.q, 'with the reason');
});

test('bad fixes past the 2000 the processing document lists are still left off the route', () => {
  // A day of terrible GPS: 2500 low-accuracy fixes between the good ones.
  const good = POINTS.slice(0, 40).map((x) => ({ ...x }));
  const t0 = good[good.length - 1].deviceTs;
  const bad = Array.from({ length: 2500 }, (_, i) => ({
    clientPointId: `bad:${i}`, lat: 18.6 + (i % 7) * 0.01, lng: 73.7, deviceTs: t0 + 1000 + i * 10, accuracyM: 900,
  }));
  const pts = good.concat(bad);
  const p = process_(pts);
  assert.equal(p.track.excludedPointsTruncated, true, 'the stored list is capped');
  const r = buildReplay(pts, p);
  const badTs = new Set(bad.map((b) => b.deviceTs));
  assert.equal(r.points.filter((q) => badTs.has(q.ts) && q.used).length, 0, 'not one bad fix drawn as road');
});

test('each counted fix says what the stretch ending at it counted as', () => {
  const p = process_(POINTS.map((x) => ({ ...x })));
  const r = buildReplay(POINTS.map((x) => ({ ...x })), p);
  const kinds = new Set(r.points.filter((q) => q.used).map((q) => q.b));
  assert.ok(kinds.has('business'), 'driving to restaurants is business');
  assert.ok(kinds.has('personal'), 'the Porter jobs are personal');
  for (const k of kinds) assert.ok(['business', 'personal', 'unknown', 'gap'].includes(k), k);

  // Near Personal 2 (no restaurant anywhere near) the route is personal.
  const near = r.points.filter((q) => q.used && Math.abs(q.lat - PLACES.PERSONAL_2.lat) < 0.002 && Math.abs(q.lng - PLACES.PERSONAL_2.lng) < 0.002);
  assert.ok(near.length, 'the track passes Personal 2');
  assert.ok(near.every((q) => q.b !== 'business'), 'never business at a Porter drop');
});

test('GPS silences come back as gaps, so the map can draw them dashed', () => {
  const p = process_(POINTS.map((x) => ({ ...x })));
  const r = buildReplay(POINTS.map((x) => ({ ...x })), p);
  assert.equal(r.gaps.length, p.track.gaps.length);
  assert.ok(r.gaps.length >= 1);
  const used = new Set(r.points.filter((q) => q.used).map((q) => q.ts));
  for (const g of r.gaps) assert.ok(used.has(g.fromTs) && used.has(g.toTs), 'a gap starts and ends at counted fixes');
});

test('a ride not calculated yet is still shown, undecided', () => {
  const r = buildReplay(POINTS.slice(0, 5).map((x) => ({ ...x })), null);
  assert.equal(r.calculated, false);
  assert.equal(r.points.length, 5);
  assert.ok(r.points.every((q) => q.used && q.b === 'unknown'));
});

test('a hop between a stop and a drive belongs to the drive, as in the calculation', () => {
  const segs = [
    { kind: 'travel', startTs: 0, endTs: 100, type: 'BUSINESS_TRAVEL', confidence: 'HIGH' },
    { kind: 'stop', startTs: 110, endTs: 200, type: 'LIKELY_RESTAURANT_VISIT', confidence: 'HIGH' },
    { kind: 'travel', startTs: 200, endTs: 300, type: 'PERSONAL_OR_NON_BUSINESS', confidence: 'HIGH' },
  ];
  assert.equal(segmentFor(segs, 50, 60), segs[0], 'inside a drive');
  assert.equal(segmentFor(segs, 100, 110), segs[0], 'drive → stop: the drive');
  assert.equal(segmentFor(segs, 200, 210), segs[2], 'stop → drive: the drive');
  assert.equal(segmentFor(segs, 150, 160), segs[1], 'inside a stop');
});

test('the ride API sends the replay, and raw points only when asked for by name', () => {
  const admin = read('backend/src/routes/admin.js');
  const fn = admin.slice(admin.indexOf("router.get('/rides/:rideId'"), admin.indexOf("router.post('/rides/:rideId/stop'"));
  assert.match(fn, /replay: points \? buildReplay\(points, processing\) : null/);
  assert.match(fn, /points: req\.query\.points === 'raw' \? points : null/);
});

test('the dashboard draws the replay, with playback, and report routes split at gaps', () => {
  const views = read('dashboard/views.js');
  assert.match(views, /MAPS\.drawReplay\(h, rp, \{ visits: visits \}\)/);
  assert.match(views, /id="rpPlay"/);
  assert.match(views, /id="rpSeek"/);
  // Reports: counted fixes only, a new line after every gap.
  assert.match(views, /if \(!q\.used\) return;/);
  assert.match(views, /if \(gapAfter\[q\.ts\]\) \{ if \(cur\.length > 1\) lines\.push\(cur\); cur = \[\]; \}/);
  // Only nearby restaurants on a replay, not all three thousand.
  assert.match(views, /MAPS\.drawPlaces\(h, 'near', near,/);
  const map = read('dashboard/map.js');
  assert.match(map, /dashed: true/);
});
