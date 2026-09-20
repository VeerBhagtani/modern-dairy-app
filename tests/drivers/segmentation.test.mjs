// Segmentation invariants.
//
// These are the properties that make double-counting impossible rather than
// merely unlikely, so they are checked over randomly generated tracks and not
// just a hand-picked example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { rng } from './helpers/journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { resolveConfig } = require('./src/drivers/config');
const { cleanTrack } = require('./src/drivers/track');
const { detectStops } = require('./src/drivers/stops');
const { buildSegments } = require('./src/drivers/segmentation');

const { config: CFG } = resolveConfig();
const T0 = Date.parse('2026-09-15T03:30:00Z');

// A random walk that parks at random intervals — a crude but effective
// generator of the shapes a real day takes.
function randomDay(seed) {
  const rand = rng(seed);
  const points = [];
  let lat = 18.5;
  let lng = 73.85;
  let ts = T0;
  let i = 0;
  const push = () => {
    points.push({ clientPointId: `d:${String(i).padStart(5, '0')}`, lat, lng, deviceTs: ts, accuracyM: 5 + rand() * 20 });
    i += 1;
    ts += 30000;
  };
  for (let leg = 0; leg < 8; leg += 1) {
    const steps = 5 + Math.floor(rand() * 25);
    const dLat = (rand() - 0.5) * 0.002;
    const dLng = (rand() - 0.5) * 0.002;
    for (let s = 0; s < steps; s += 1) { lat += dLat; lng += dLng; push(); }
    if (rand() > 0.35) {
      const dwell = 4 + Math.floor(rand() * 20);   // 2–12 minutes parked
      for (let s = 0; s < dwell; s += 1) {
        lat += (rand() - 0.5) * 0.00008;
        lng += (rand() - 0.5) * 0.00008;
        push();
      }
    }
    if (rand() > 0.8) ts += 900000;                 // a 15-minute tracking gap
  }
  return points;
}

test('every point belongs to exactly one segment', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const track = cleanTrack(randomDay(seed), CFG, T0 + 12 * 3600 * 1000);
    const stops = detectStops(track.points, CFG);
    const { segments, pointSegment } = buildSegments(track.points, track.hops, stops);
    assert.equal(pointSegment.length, track.points.length);
    for (let i = 0; i < track.points.length; i += 1) {
      assert.ok(pointSegment[i] >= 0 && pointSegment[i] < segments.length,
        `seed ${seed}: point ${i} belongs to no segment`);
    }
    // And the ranges do not overlap.
    const covered = new Set();
    for (const seg of segments) {
      if (seg.startIdx == null) continue;
      for (let i = seg.startIdx; i <= seg.endIdx; i += 1) {
        assert.ok(!covered.has(i), `seed ${seed}: point ${i} is in two segments`);
        covered.add(i);
      }
    }
    assert.equal(covered.size, track.points.length);
  }
});

test('every hop is attributed to exactly one segment, and the totals agree', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const track = cleanTrack(randomDay(seed), CFG, T0 + 12 * 3600 * 1000);
    const stops = detectStops(track.points, CFG);
    const { segments } = buildSegments(track.points, track.hops, stops);

    const segMeasured = segments.reduce((s, x) => s + x.distanceM, 0);
    const segGap = segments.reduce((s, x) => s + x.gapEstimateM, 0);
    const segHops = segments.reduce((s, x) => s + x.hopCount, 0);

    assert.equal(segHops, track.hops.length, `seed ${seed}: hops lost or duplicated`);
    assert.ok(Math.abs(segMeasured - track.totals.measuredM) < 0.001,
      `seed ${seed}: segment distance ${segMeasured} != track distance ${track.totals.measuredM}`);
    assert.ok(Math.abs(segGap - track.totals.gapEstimateM) < 0.001, `seed ${seed}: gap distance mismatch`);
  }
});

test('segments are in time order and alternate travel and stop', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const track = cleanTrack(randomDay(seed), CFG, T0 + 12 * 3600 * 1000);
    const stops = detectStops(track.points, CFG);
    const { segments } = buildSegments(track.points, track.hops, stops);
    let lastEnd = -Infinity;
    for (let i = 0; i < segments.length; i += 1) {
      const s = segments[i];
      if (s.startTs != null) {
        assert.ok(s.startTs >= lastEnd - 1, `seed ${seed}: segment ${i} starts before the previous one ends`);
        lastEnd = s.endTs;
      }
      if (i > 0) assert.notEqual(s.kind, segments[i - 1].kind, `seed ${seed}: two ${s.kind} segments in a row`);
    }
  }
});

test('a day with no stops is one travel segment holding all the distance', () => {
  const points = [];
  for (let i = 0; i <= 40; i += 1) {
    points.push({ clientPointId: `d:${i}`, lat: 18.5 + i * 0.001, lng: 73.85, deviceTs: T0 + i * 30000, accuracyM: 8 });
  }
  const track = cleanTrack(points, CFG, T0 + 3600000);
  const stops = detectStops(track.points, CFG);
  const { segments } = buildSegments(track.points, track.hops, stops);
  assert.equal(stops.length, 0);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'travel');
  assert.ok(Math.abs(segments[0].distanceM - track.totals.measuredM) < 0.001);
});

test('a dwell shorter than the threshold is not a stop', () => {
  const points = [];
  let i = 0;
  const push = (lat, lng, ts) => { points.push({ clientPointId: `d:${i += 1}`, lat, lng, deviceTs: ts, accuracyM: 8 }); };
  for (let k = 0; k < 10; k += 1) push(18.5 + k * 0.001, 73.85, T0 + k * 30000);
  // 90 seconds at a traffic light — under the 180 s threshold.
  for (let k = 0; k < 3; k += 1) push(18.51, 73.85, T0 + 300000 + k * 30000);
  for (let k = 0; k < 10; k += 1) push(18.511 + k * 0.001, 73.85, T0 + 400000 + k * 30000);
  const track = cleanTrack(points, CFG, T0 + 3600000);
  assert.equal(detectStops(track.points, CFG).length, 0);
});
