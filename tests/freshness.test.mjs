// Kilometres are calculated without anybody pressing a button.
//
// They were not. A ride was calculated only on "Calculate now" or a manual
// maintenance run, and maintenance skipped rides still running — which, since
// only the office stops a ride, was every ride. Phones sent thousands of points
// and the dashboard showed no kilometres at all. These tests hold the rules
// that replaced that.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const { needsCalc, keepCurrent, makeHousekeeper, FRESH_MS } = require_(path.join(ROOT, 'backend/src/services/freshness.js'));

const NOW = Date.parse('2026-09-24T12:00:00+05:30');
const MIN = 60 * 1000;

test('a ride with points and no result is calculated', () => {
  assert.equal(needsCalc({ status: 'active', pointCount: 400 }, NOW), true);
  assert.equal(needsCalc({ status: 'stopped', pointCount: 400 }, NOW), true);
});

test('a ride with no points is not "calculated" into a zero', () => {
  // Zero kilometres and "no data" are different facts; calculating an empty
  // ride would turn the second into the first.
  assert.equal(needsCalc({ status: 'active', pointCount: 0 }, NOW), false);
  assert.equal(needsCalc({ status: 'active' }, NOW), false);
});

test('a running ride calculated early is recalculated once new points arrive', () => {
  // The office's exact symptom: "Calculate now" pressed early froze a
  // near-empty answer for the rest of the day.
  const ride = { status: 'active', pointCount: 900, processedAt: NOW - 40 * MIN, lastUploadAt: NOW - 1 * MIN };
  assert.equal(needsCalc(ride, NOW), true);
});

test('a running ride is not recalculated on every dashboard refresh', () => {
  // The dashboard refreshes every few seconds; each calculation re-reads the
  // whole day's points.
  const ride = { status: 'active', pointCount: 900, processedAt: NOW - 2 * MIN, lastUploadAt: NOW - 30 * 1000 };
  assert.equal(needsCalc(ride, NOW), false);
  assert.equal(needsCalc({ ...ride, processedAt: NOW - FRESH_MS }, NOW), true);
});

test('nothing new since the last calculation means nothing to do', () => {
  const ride = { status: 'active', pointCount: 900, processedAt: NOW - 60 * MIN, lastUploadAt: NOW - 61 * MIN };
  assert.equal(needsCalc(ride, NOW), false);
});

test('a finished ride with points its result has not seen is recalculated at once', () => {
  // A stopped ride's last points often land after its final live calculation.
  const ride = { status: 'stopped', pointCount: 900, processedAt: NOW - 1 * MIN, lastUploadAt: NOW - 30 * 1000 };
  assert.equal(needsCalc(ride, NOW), true);
});

test('keepCurrent calculates what is due, oldest result first, and skips the rest', async () => {
  const done = [];
  const rides = [
    { id: 'fresh', status: 'active', pointCount: 5, processedAt: NOW - 1 * MIN, lastUploadAt: NOW },
    { id: 'never', status: 'active', pointCount: 5 },
    { id: 'stale', status: 'active', pointCount: 5, processedAt: NOW - 30 * MIN, lastUploadAt: NOW },
    { id: 'empty', status: 'active', pointCount: 0 },
  ];
  const out = await keepCurrent(rides, { processOne: async (id) => { done.push(id); }, now: () => NOW });
  assert.deepEqual(done, ['never', 'stale']);
  assert.deepEqual(out.calculated, ['never', 'stale']);
  assert.equal(out.deferred, 0);
});

test('one ride failing does not stop the others', async () => {
  const rides = [{ id: 'a', status: 'stopped', pointCount: 3 }, { id: 'b', status: 'stopped', pointCount: 3 }];
  const out = await keepCurrent(rides, {
    processOne: async (id) => { if (id === 'a') throw new Error('bad data'); },
    now: () => NOW,
  });
  assert.deepEqual(out.calculated, ['b']);
  assert.equal(out.failed[0].rideId, 'a');
});

test('a backlog is spread across requests instead of blocking one', async () => {
  const rides = Array.from({ length: 25 }, (_, i) => ({ id: 'r' + i, status: 'stopped', pointCount: 3 }));
  const out = await keepCurrent(rides, { processOne: async () => {}, now: () => NOW }, { maxRides: 10 });
  assert.equal(out.calculated.length, 10);
  assert.equal(out.deferred, 15, 'the rest are left for the next look, and counted');
});

test('the time budget is respected', async () => {
  let clock = NOW;
  const rides = Array.from({ length: 5 }, (_, i) => ({ id: 'r' + i, status: 'stopped', pointCount: 3 }));
  const out = await keepCurrent(rides, {
    processOne: async () => { clock += 3000; },   // each ride takes 3 s
    now: () => clock,
  }, { budgetMs: 8000, maxRides: 10 });
  assert.ok(out.calculated.length <= 4, `stopped near the budget, did ${out.calculated.length}`);
  assert.ok(out.deferred >= 1);
});

test('the automatic close-out runs, but not on every request', async () => {
  let runs = 0;
  const hk = makeHousekeeper(async () => { runs += 1; return []; }, { everyMs: 10 * MIN });
  await hk(NOW);
  await hk(NOW + 1 * MIN);
  await hk(NOW + 5 * MIN);
  assert.equal(runs, 1);
  await hk(NOW + 11 * MIN);
  assert.equal(runs, 2);
});

test('a failing close-out never breaks the dashboard', async () => {
  const hk = makeHousekeeper(async () => { throw new Error('firestore down'); });
  const out = await hk(NOW);
  assert.match(out.error, /firestore down/);
});
