// Reading Google's route matrix back.
//
// The response is a flat list of {originIndex, destinationIndex} pairs into the
// arrays that were sent, which is exactly the kind of thing that works in
// testing and silently transposes in production — giving every driver a plan
// built on the distances between the wrong places. So it is pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const rm = require_(path.join(ROOT, 'backend/src/services/routeMatrix.js'));

const O = [{ id: 'A', lat: 18.5, lng: 73.8 }, { id: 'B', lat: 18.6, lng: 73.9 }];
const D = [{ id: 'B', lat: 18.6, lng: 73.9 }, { id: 'C', lat: 18.7, lng: 73.7 }];

test('an element lands on the pair it actually describes', () => {
  const out = rm.readMatrix([
    { originIndex: 0, destinationIndex: 1, distanceMeters: 5000, duration: '900s', condition: 'ROUTE_EXISTS' },
    { originIndex: 1, destinationIndex: 1, distanceMeters: 3000, duration: '600s', condition: 'ROUTE_EXISTS' },
  ], O, D);
  assert.deepEqual(out['A>C'], { distanceM: 5000, durationS: 900 });
  assert.deepEqual(out['B>C'], { distanceM: 3000, durationS: 600 });
  assert.equal(Object.keys(out).length, 2);
});

test('a place paired with itself is not a leg', () => {
  const out = rm.readMatrix(
    [{ originIndex: 1, destinationIndex: 0, distanceMeters: 0, duration: '0s', condition: 'ROUTE_EXISTS' }],
    O, D,
  );
  assert.deepEqual(out, {}, 'B to B must not become a zero-distance leg');
});

test('no road between two points stays unknown, rather than becoming zero', () => {
  // ROUTE_NOT_FOUND arrives as a condition on a successful response. Treating
  // it as an answer would make the optimiser prefer the impossible leg.
  const out = rm.readMatrix(
    [{ originIndex: 0, destinationIndex: 1, condition: 'ROUTE_NOT_FOUND' }],
    O, D,
  );
  assert.deepEqual(out, {});
});

test('a duration is read out of the protobuf string form', () => {
  assert.equal(rm.parseDuration('1234s'), 1234);
  assert.equal(rm.parseDuration('12.5s'), 12.5);
  assert.equal(rm.parseDuration(90), 90);
  assert.ok(Number.isNaN(rm.parseDuration('soon')));
  assert.ok(Number.isNaN(rm.parseDuration(undefined)));
});

test('a row with no usable numbers is skipped, not stored as NaN', () => {
  const out = rm.readMatrix([
    { originIndex: 0, destinationIndex: 1, distanceMeters: 0, duration: '10s', condition: 'ROUTE_EXISTS' },
    { originIndex: 0, destinationIndex: 1, distanceMeters: 500, duration: 'later', condition: 'ROUTE_EXISTS' },
  ], O, D);
  assert.deepEqual(out, {});
});

test('asking about nothing costs nothing', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => [] }; };
  assert.deepEqual(await rm.fetchLegs([], 'KEY', { fetchImpl }), {});
  assert.equal(called, false, 'an empty plan must not reach the network');
});

test('only the legs asked about are paid for, and duplicates collapse', async () => {
  // Three legs over three places is a 3x3 rectangle at worst; the point is that
  // each place appears once, not once per leg.
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => [] };
  };
  const A = { id: 'A', lat: 1, lng: 1 }, B = { id: 'B', lat: 2, lng: 2 }, C = { id: 'C', lat: 3, lng: 3 };
  await rm.fetchLegs([{ from: A, to: B }, { from: A, to: C }, { from: B, to: C }], 'KEY', { fetchImpl });
  assert.equal(sent.origins.length, 2, 'A and B');
  assert.equal(sent.destinations.length, 2, 'B and C');
});

test('a runaway request is refused rather than billed', async () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) {
    many.push({ from: { id: `o${i}`, lat: 1, lng: 1 }, to: { id: `d${i}`, lat: 2, lng: 2 } });
  }
  await assert.rejects(
    rm.fetchLegs(many, 'KEY', { fetchImpl: async () => ({ ok: true, json: async () => [] }) }),
    /Refusing to price/,
  );
});

test('a key without Routes access says so', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: 'Routes API has not been used in project ...' } }),
  });
  await assert.rejects(
    rm.fetchLegs([{ from: O[0], to: D[1] }], 'KEY', { fetchImpl }),
    (e) => e.notEnabled === true,
  );
});
