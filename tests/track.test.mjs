// GPS validation, cleaning and distance measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { rng } from './helpers/journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { resolveConfig } = require('./src/drivers/config');
const { cleanTrack, trackQuality } = require('./src/drivers/track');
const { normaliseIncomingPoint, QUALITY } = require('./src/drivers/validation');

const { config: CFG } = resolveConfig();
const T0 = Date.parse('2026-09-15T03:30:00Z');
const NOW = T0 + 6 * 3600 * 1000;

function pt(i, lat, lng, extra = {}) {
  return { clientPointId: `d:${String(i).padStart(4, '0')}`, lat, lng, deviceTs: T0 + i * 30000, accuracyM: 10, ...extra };
}

// ── ingest validation ────────────────────────────────────────────────────

test('ingest rejects malformed points and says why', () => {
  const opts = { nowMs: NOW, clockSkewMin: CFG.clockSkewMin };
  const cases = [
    [{}, /clientPointId/],
    [{ clientPointId: '../../etc/passwd', lat: 1, lng: 1, deviceTs: T0 }, /clientPointId/],
    [{ clientPointId: 'a', lat: 91, lng: 1, deviceTs: T0 }, /lat/],
    [{ clientPointId: 'a', lat: 1, lng: 181, deviceTs: T0 }, /lng/],
    [{ clientPointId: 'a', lat: 0, lng: 0, deviceTs: T0 }, /null island/],
    [{ clientPointId: 'a', lat: 18, lng: 73 }, /deviceTs/],
    [{ clientPointId: 'a', lat: 18, lng: 73, deviceTs: NOW + 99 * 3600000 }, /future/],
    [{ clientPointId: 'a', lat: 18, lng: 73, deviceTs: T0, accuracyM: -5 }, /accuracyM/],
  ];
  for (const [raw, re] of cases) {
    const { error } = normaliseIncomingPoint(raw, opts);
    assert.match(String(error), re);
  }
});

test('ingest stores only the fields we define — a client cannot inject one', () => {
  const { point } = normaliseIncomingPoint({
    clientPointId: 'd:1', lat: 18.5, lng: 73.85, deviceTs: T0,
    verifiedBusiness: true, role: 'admin', distanceM: 999999,
  }, { nowMs: NOW, clockSkewMin: 30 });
  assert.ok(point);
  assert.equal(point.verifiedBusiness, undefined);
  assert.equal(point.role, undefined);
  assert.equal(point.distanceM, undefined);
});

// ── cleaning ─────────────────────────────────────────────────────────────

test('a stationary noisy cloud produces essentially zero distance', () => {
  const rand = rng(7);
  const points = [];
  for (let i = 0; i < 60; i += 1) {
    // ±8 m of jitter around one spot for half an hour.
    points.push(pt(i, 18.5 + (rand() - 0.5) * 16 / 111320, 73.85 + (rand() - 0.5) * 16 / 111320));
  }
  const t = cleanTrack(points, CFG, NOW);
  const unfiltered = cleanTrack(points, { ...CFG, minMoveM: 0 }, NOW);
  assert.equal(t.totals.acceptedCount, 60);
  // The filter cannot reach exactly zero — two fixes can genuinely land 20 m
  // apart inside an 8 m noise cloud — but it must remove the great majority,
  // and what is left must be small enough to disappear at the 0.1 km
  // resolution the system reports. Half an hour parked reads as 0.1 km.
  assert.ok(t.totals.measuredM < unfiltered.totals.measuredM / 3,
    `filter kept ${Math.round(t.totals.measuredM)} m of ${Math.round(unfiltered.totals.measuredM)} m of pure noise`);
  assert.ok(t.totals.measuredM < 250, `parked phone invented ${Math.round(t.totals.measuredM)} m`);
  assert.ok(t.totals.jitterM > 0, 'the jitter that was filtered should still be counted somewhere');
});

test('a straight run measures the straight-line distance', () => {
  const points = [];
  for (let i = 0; i <= 20; i += 1) points.push(pt(i, 18.5 + i * 0.001, 73.85));
  const t = cleanTrack(points, CFG, NOW);
  // 20 × 0.001° of latitude = 0.02° ≈ 2224 m.
  assert.ok(Math.abs(t.totals.measuredM - 2224) < 15, `got ${Math.round(t.totals.measuredM)} m`);
  assert.equal(t.totals.gapEstimateM, 0);
});

test('a teleport spike is rejected and adds no distance', () => {
  const clean = [];
  for (let i = 0; i <= 10; i += 1) clean.push(pt(i, 18.5 + i * 0.001, 73.85));
  const withSpike = clean.slice(0, 5)
    .concat([{ clientPointId: 'd:spike', lat: 18.9, lng: 74.2, deviceTs: T0 + 5 * 30000 + 15000, accuracyM: 12 }])
    .concat(clean.slice(5));
  const a = cleanTrack(clean, CFG, NOW);
  const b = cleanTrack(withSpike, CFG, NOW);
  assert.equal(b.totals.byReason[QUALITY.IMPLAUSIBLE_JUMP], 1);
  assert.ok(Math.abs(a.totals.measuredM - b.totals.measuredM) < 1,
    'a rejected spike must not change the measured distance at all');
  // And it is still present in the output, with its reason.
  const spike = b.points.find((p) => p.clientPointId === 'd:spike');
  assert.equal(spike.countDistance, false);
  assert.match(spike.qualityDetail, /m\/s/);
});

test('a duplicate upload cannot double-count', () => {
  const points = [];
  for (let i = 0; i <= 10; i += 1) points.push(pt(i, 18.5 + i * 0.001, 73.85));
  const once = cleanTrack(points, CFG, NOW);
  const twice = cleanTrack(points.concat(points), CFG, NOW);
  assert.equal(twice.totals.byReason[QUALITY.DUPLICATE], 11);
  assert.ok(Math.abs(once.totals.measuredM - twice.totals.measuredM) < 1e-6);
});

test('input order does not change the result', () => {
  const points = [];
  for (let i = 0; i <= 30; i += 1) points.push(pt(i, 18.5 + i * 0.0008, 73.85 + i * 0.0003));
  const forward = cleanTrack(points, CFG, NOW);
  const shuffled = cleanTrack([...points].reverse(), CFG, NOW);
  assert.ok(Math.abs(forward.totals.measuredM - shuffled.totals.measuredM) < 1e-6);
  assert.deepEqual(forward.points.map((p) => p.clientPointId), shuffled.points.map((p) => p.clientPointId));
});

test('a long silence becomes a gap estimate, never measured distance', () => {
  const points = [];
  for (let i = 0; i <= 5; i += 1) points.push(pt(i, 18.5 + i * 0.001, 73.85));
  // 20 minutes later, 5 km away.
  for (let i = 0; i <= 5; i += 1) {
    points.push({ clientPointId: `d:late${i}`, lat: 18.55 + i * 0.001, lng: 73.85, deviceTs: T0 + 5 * 30000 + 1200000 + i * 30000, accuracyM: 10 });
  }
  const t = cleanTrack(points, CFG, NOW);
  assert.equal(t.gaps.length, 1);
  assert.ok(t.totals.gapEstimateM > 4000, 'the gap distance should be estimated, not dropped');
  assert.ok(t.totals.totalM > t.totals.measuredM, 'the day total includes the estimate');
  // And the estimate is labelled as one.
  const gapHop = t.hops.find((h) => h.acrossGap);
  assert.equal(gapHop.method, 'estimated');
});

test('fixes worse than the accuracy limit are excluded but kept', () => {
  // 0.002° of latitude per 30 s ≈ 27 km/h — an ordinary city speed, so the
  // point after the excluded one is judged on its own merits rather than
  // tripping the implausible-jump rule.
  const points = [pt(0, 18.5, 73.85), pt(1, 18.502, 73.85, { accuracyM: 900 }), pt(2, 18.504, 73.85)];
  const t = cleanTrack(points, CFG, NOW);
  assert.equal(t.points.length, 3, 'nothing is ever deleted');
  assert.equal(t.points[1].quality, QUALITY.BAD_ACCURACY);
  assert.equal(t.totals.acceptedCount, 2);
});

test('mock locations are excluded from distance and flagged', () => {
  const points = [pt(0, 18.5, 73.85), pt(1, 18.501, 73.85, { mock: true }), pt(2, 18.502, 73.85)];
  const t = cleanTrack(points, CFG, NOW);
  assert.equal(t.totals.byReason[QUALITY.MOCK_LOCATION], 1);
  assert.equal(t.points[1].countDistance, false);
});

test('the quality grade reflects real problems, not a vibe', () => {
  const good = cleanTrack(Array.from({ length: 100 }, (_, i) => pt(i, 18.5 + i * 0.0005, 73.85)), CFG, NOW);
  assert.equal(trackQuality(good.totals, CFG).grade, 'good');

  const sparse = cleanTrack([pt(0, 18.5, 73.85), pt(120, 18.6, 73.85)], CFG, NOW);
  const q = trackQuality(sparse.totals, CFG);
  assert.notEqual(q.grade, 'good');
  assert.ok(q.reasons.length > 0);
});

test('no points is reported as no data, not as zero kilometres', () => {
  const t = cleanTrack([], CFG, NOW);
  assert.equal(t.totals.rawCount, 0);
  assert.equal(trackQuality(t.totals, CFG).grade, 'no_data');
});
