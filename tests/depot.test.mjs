// The Market Yard depot: the drive back to it is recognised, and a missing or
// misplaced depot is reported rather than silently degrading classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { depotCheck, MARKET_YARD_AREA } = require('./src/services/depotCheck');

const DEPOT = { id: 'depot', name: 'Modern Dairy, Market Yard', lat: 18.4872, lng: 73.8661, radiusM: 120 };
const R = { id: 'R', name: 'Hotel Test', lat: 18.5010, lng: 73.8661, radiusM: 80 };
const T0 = Date.parse('2026-09-15T03:30:00Z');

function day() {
  const pts = []; let t = T0; let n = 0;
  const at = (lat, lng) => { pts.push({ clientPointId: `p${n += 1}`, lat, lng, deviceTs: t, accuracyM: 8 }); t += 20000; };
  for (let i = 0; i < 12; i += 1) at(DEPOT.lat, DEPOT.lng);                                   // loading at the depot
  for (let i = 1; i < 20; i += 1) at(DEPOT.lat + (R.lat - DEPOT.lat) * i / 20, DEPOT.lng);    // drive out
  for (let i = 0; i < 15; i += 1) at(R.lat, R.lng);                                           // delivering
  for (let i = 1; i < 20; i += 1) at(R.lat - (R.lat - DEPOT.lat) * i / 20, DEPOT.lng);        // drive back
  for (let i = 0; i < 12; i += 1) at(DEPOT.lat, DEPOT.lng);                                   // back at the depot
  return pts;
}

test('with the depot configured, the drive back is RETURN_TO_MODERN_DAIRY and the drive out a departure', () => {
  const r = processRideData({ points: day(), ride: { id: 'x', driverId: 'd', startedAt: T0 }, facilities: [DEPOT], restaurants: [R],
    orders: [], declarations: [], reviews: [], nowMs: T0 + 864e5 });
  const types = r.segments.filter((s) => s.kind !== 'stop' && s.distanceM > 0).map((s) => s.type);
  assert.ok(types.includes('MODERN_DAIRY_DEPARTURE'), types.join(','));
  assert.ok(types.includes('RETURN_TO_MODERN_DAIRY'), types.join(','));
  assert.equal(r.distance.reconciliation.ok, true);
});

test('without the depot, the same return is not called a return to Modern Dairy', () => {
  const r = processRideData({ points: day(), ride: { id: 'x', driverId: 'd', startedAt: T0 }, facilities: [], restaurants: [R],
    orders: [], declarations: [], reviews: [], nowMs: T0 + 864e5 });
  assert.ok(!r.segments.some((s) => s.type === 'RETURN_TO_MODERN_DAIRY'));
});

test('depot check: missing, misplaced and correct', () => {
  assert.match(depotCheck([]).warning, /No Modern Dairy facility has a location/);
  assert.match(depotCheck([{ name: 'Old depot', lat: 18.60, lng: 73.80 }]).warning, /No facility is near Market Yard/);
  const ok = depotCheck([DEPOT]);
  assert.equal(ok.warning, null);
  assert.equal(ok.nearMarketYard, true);
  assert.equal(ok.namedMarketYard, 1);
  assert.ok(ok.nearestToMarketYardM < 200);
  assert.equal(depotCheck([{ ...DEPOT, active: false }]).facilities, 0, 'an inactive facility does not count');
  assert.ok(Number.isFinite(MARKET_YARD_AREA.lat));
});
