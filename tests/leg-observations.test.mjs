// Learning roads from rides that already happened.
//
// This is where the routing feature gets its facts, so the tests are mostly
// about what it REFUSES to learn. An observation measured across a GPS gap is
// partly invented, and feeding invented distances back in as evidence would
// teach the system a shortcut that does not exist — which it would then put in
// front of a driver as advice.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const lo = require_(path.join(ROOT, 'backend/src/drivers/legObservations.js'));

const T0 = Date.UTC(2026, 0, 5, 4, 0, 0);
const min = (n) => n * 60000;

// A visit as distancePerVisit() produces it.
const visit = (placeId, arrivedMin, departedMin, approachDistanceM, approachGapEstimateM = 0) => ({
  placeId,
  arrivedAt: T0 + min(arrivedMin),
  departedAt: T0 + min(departedMin),
  approachDistanceM,
  approachGapEstimateM,
});

test('consecutive visits describe the leg between them', () => {
  const { observations } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    visit('B', 25, 35, 2200),
  ]);
  assert.equal(observations.length, 1);
  assert.deepEqual(
    { from: observations[0].from, to: observations[0].to, distanceM: observations[0].distanceM },
    { from: 'A', to: 'B', distanceM: 2200 },
  );
  // Left A at 10 min, reached B at 25 min: fifteen minutes on the road.
  assert.equal(observations[0].durationS, 900);
});

test('three restaurants give two legs and the order they were done in', () => {
  const { observations, sequence } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    visit('B', 25, 35, 2200),
    visit('C', 50, 60, 1800),
  ]);
  assert.deepEqual(observations.map((o) => `${o.from}>${o.to}`), ['A>B', 'B>C']);
  assert.deepEqual(sequence, ['A', 'B', 'C']);
});

test('a stop that is not a known restaurant teaches nothing', () => {
  // A driver stopping at a petrol pump is not a leg between customers.
  const { observations, sequence } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    { ...visit('?', 25, 30, 2000), placeId: null },
    visit('B', 45, 55, 2500),
  ]);
  assert.deepEqual(sequence, ['A', 'B']);
  assert.equal(observations.length, 1, 'the unmatched stop drops out of the chain');
});

// ── what it refuses ──────────────────────────────────────────────────────────

test('a distance that was mostly guessed is not evidence', () => {
  // 2 km measured, 1 km invented across a signal blackout. Learning from this
  // would tell the system the leg is shorter than it is, forever.
  const { observations, rejected } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    visit('B', 25, 35, 2000, 1000),
  ]);
  assert.equal(observations.length, 0);
  assert.equal(rejected[0].reason, lo.REJECT.GAPPY);
});

test('a small gap is tolerated, because no trace is perfect', () => {
  const { observations } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    visit('B', 25, 35, 2000, 50),
  ]);
  assert.equal(observations.length, 1);
});

test('a lunch break in the middle is not how long the road takes', () => {
  const { observations, rejected } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    visit('B', 10 + 4 * 60, 300, 2200),   // four hours later
  ]);
  assert.equal(observations.length, 0);
  assert.equal(rejected[0].reason, lo.REJECT.TOO_LONG);
});

test('two stops at the same restaurant are not a journey', () => {
  const { observations, rejected } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    visit('A', 25, 35, 2200),
  ]);
  assert.equal(observations.length, 0);
  assert.equal(rejected[0].reason, lo.REJECT.SAME_PLACE);
});

test('a leg nobody could have driven that fast is thrown out', () => {
  // 40 km in four minutes. Either the clock or the GPS is wrong; either way it
  // must not become the estimate this driver is planned around.
  const { observations, rejected } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    visit('B', 14, 25, 40000),
  ]);
  assert.equal(observations.length, 0);
  assert.equal(rejected[0].reason, lo.REJECT.IMPOSSIBLE);
});

test('a hop of a few metres between adjacent shops is not a leg', () => {
  const { observations, rejected } = lo.legsFromVisits([
    visit('A', 0, 10, 3000),
    visit('B', 12, 20, 20),
  ]);
  assert.equal(observations.length, 0);
  assert.equal(rejected[0].reason, lo.REJECT.TOO_SHORT);
});

test('nothing in, nothing out — and no crash', () => {
  for (const input of [[], null, undefined, [visit('A', 0, 10, 3000)]]) {
    const r = lo.legsFromVisits(input);
    assert.deepEqual(r.observations, []);
  }
});

// ── folding many rides together ──────────────────────────────────────────────

test('repeated runs of the same leg pile up under one key', () => {
  const grouped = lo.groupByLeg([
    { from: 'A', to: 'B', distanceM: 2200, durationS: 900, at: 1 },
    { from: 'A', to: 'B', distanceM: 2100, durationS: 880, at: 2 },
    { from: 'B', to: 'A', distanceM: 2600, durationS: 1000, at: 3 },
  ]);
  assert.equal(grouped['A>B'].length, 2);
  assert.equal(grouped['B>A'].length, 1, 'the way back is its own leg');
});
