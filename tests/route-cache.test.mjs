// Paid road distances are asked for once and reused for 30 days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const rm = require('./src/services/routeMatrix');

const A = { id: 'depot', lat: 18.4884, lng: 73.8687 };
const B = { id: 'r1', lat: 18.5204, lng: 73.8567 };
const C = { id: 'r2', lat: 18.5310, lng: 73.8446 };

function fakeGoogle() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const rows = [];
    body.origins.forEach((o, oi) => body.destinations.forEach((d, di) => rows.push({ originIndex: oi, destinationIndex: di, condition: 'ROUTE_EXISTS', distanceMeters: 1000 + oi * 10 + di, duration: '300s' })));
    return { ok: true, json: async () => rows };
  };
  return { calls, fetchImpl };
}
function memCache() {
  const m = new Map();
  return { m, getMany: async (keys) => Object.fromEntries(keys.filter((k) => m.has(k)).map((k) => [k, m.get(k)])), putMany: async (e) => Object.entries(e).forEach(([k, v]) => m.set(k, v)) };
}

test('a leg is bought once, then served from the cache', async () => {
  const g = fakeGoogle(); const cache = memCache(); const now = Date.parse('2026-09-25T04:00:00Z');
  const first = await rm.cachedFetchLegs([{ from: A, to: B }, { from: B, to: C }], 'k', { cache, nowMs: now, fetchImpl: g.fetchImpl });
  assert.equal(g.calls.length, 1);
  assert.deepEqual(first.stats, { hits: 0, misses: 2 });
  assert.equal(cache.m.size, 2);
  const second = await rm.cachedFetchLegs([{ from: A, to: B }, { from: B, to: C }], 'k', { cache, nowMs: now + 864e5, fetchImpl: g.fetchImpl });
  assert.equal(g.calls.length, 1, 'no second request');
  assert.deepEqual(second.stats, { hits: 2, misses: 0 });
  assert.deepEqual(second['depot>r1'], first['depot>r1']);
});

test('only the missing legs are asked for; expired answers are asked again', async () => {
  const g = fakeGoogle(); const cache = memCache(); const now = Date.parse('2026-09-25T04:00:00Z');
  await rm.cachedFetchLegs([{ from: A, to: B }], 'k', { cache, nowMs: now, fetchImpl: g.fetchImpl });
  await rm.cachedFetchLegs([{ from: A, to: B }, { from: A, to: C }], 'k', { cache, nowMs: now, fetchImpl: g.fetchImpl });
  assert.equal(g.calls[1].destinations.length, 1, 'only r2 was asked about');
  await rm.cachedFetchLegs([{ from: A, to: B }], 'k', { cache, nowMs: now + rm.CACHE_TTL_MS + 1, fetchImpl: g.fetchImpl });
  assert.equal(g.calls.length, 3, 'past 30 days it is fetched again');
});

test('the key is the rounded points and the travel mode, not the stop id', () => {
  assert.equal(rm.cacheKey(A, B), '18.4884,73.8687>18.5204,73.8567:DRIVE');
  assert.equal(rm.cacheKey({ lat: 18.48841, lng: 73.86869 }, B), rm.cacheKey(A, B), 'a metre does not matter');
  assert.notEqual(rm.cacheKey({ lat: 18.4894, lng: 73.8687 }, B), rm.cacheKey(A, B), '100 m does');
  assert.notEqual(rm.cacheKey(A, B), rm.cacheKey(B, A), 'direction matters (one-way streets)');
});

test('a cache that fails is ignored, and "no road" is never cached', async () => {
  const broken = { getMany: async () => { throw new Error('down'); }, putMany: async () => { throw new Error('down'); } };
  const g = fakeGoogle();
  const out = await rm.cachedFetchLegs([{ from: A, to: B }], 'k', { cache: broken, fetchImpl: g.fetchImpl });
  assert.ok(out['depot>r1']);
  const cache = memCache();
  const none = async () => ({ ok: true, json: async () => [{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND' }] });
  await rm.cachedFetchLegs([{ from: A, to: B }], 'k', { cache, fetchImpl: none });
  assert.equal(cache.m.size, 0);
});

test('the trip planner uses the cache', () => {
  const tp = fs.readFileSync(path.join(ROOT, 'backend/src/services/tripPlanner.js'), 'utf8');
  assert.match(tp, /routeMatrix\.cachedFetchLegs\(legs, apiKey, \{ cache: repo\.routeCache,/);
  assert.doesNotMatch(tp, /routeMatrix\.fetchLegs\(/);
});
