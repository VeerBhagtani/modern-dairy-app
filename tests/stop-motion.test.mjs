// Driving past customers, a forgotten restaurant, and a jam beside a
// restaurant. Plan: A, B, C. On the way the driver passes X at speed, parks
// 4 min at D (not planned), and sits 5 min in a slow queue beside G.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { buildJourney } = require('./src/drivers/journey');
const { buildReplay } = require('./src/services/replay');
const { motionOf } = require('./src/drivers/stops');
const { haversineM } = require('./src/drivers/geo');

const T0 = Date.parse('2026-10-25T09:00:00+05:30');
const K = 111320 * Math.cos(18.5 * Math.PI / 180);
const M = (dx, dy) => ({ lat: 18.5 + dy / 111320, lng: 73.86 + dx / K });
const R = (id, x) => ({ id, name: `Restaurant ${id}`, customerId: `C${id}`, ...M(x, 0), radiusM: 80 });
const DEPOT = { id: 'depot', name: 'Modern Dairy', ...M(0, 0), radiusM: 150 };
const A = R('A', 1500); const B = R('B', 3000); const C = R('C', 4500); const X = R('X', 2200); const D = R('D', 3700); const G = R('G', 5200);
const ALL = [A, B, C, X, D, G];

function day(steps) {
  const pts = []; let t = T0; let n = 0; let here = M(0, 0);
  const fix = (p, sp, acc = 8) => pts.push({ clientPointId: `p${n += 1}`, lat: p.lat, lng: p.lng, deviceTs: t, accuracyM: acc, speedMps: sp });
  for (const s of steps) {
    if (s.to) {
      const k = Math.max(1, Math.round(haversineM(here, s.to) / 25));
      for (let i = 1; i <= k; i += 1) { t += 3500; fix({ lat: here.lat + (s.to.lat - here.lat) * i / k, lng: here.lng + (s.to.lng - here.lng) * i / k }, 7); }
      here = s.to;
    } else if (s.park) {
      for (let i = 0; i < s.park / 30; i += 1) {
        t += 30000;
        const w = s.wander ? { lat: here.lat + Math.sin(i * 1.7) * s.wander / 111320, lng: here.lng + Math.cos(i * 2.3) * s.wander / K } : here;
        fix(w, 0, s.wander ? 25 : 8);
      }
    } else if (s.crawl) {
      const start = here; const k = s.crawl / 30;
      for (let i = 1; i <= k; i += 1) { t += 30000; here = { lat: start.lat, lng: start.lng + (s.metres * i / k) / K }; fix(here, s.metres / s.crawl); }
    }
  }
  return pts;
}
const plan = ['A', 'B', 'C'].map((placeId) => ({ placeId, plannedAt: T0 }));
function run(points) {
  const ride = { id: 'r', driverId: 'd', startedAt: T0, status: 'completed', plannedStops: plan };
  const r = processRideData({ points, ride, facilities: [DEPOT], restaurants: ALL, orders: [], declarations: [], reviews: [], nowMs: T0 + 864e5 });
  const proc = { ...r, processedAt: T0 + 864e5 };
  return { r, j: buildJourney({ ride, processing: proc, replay: buildReplay(points, proc), places: { facilities: [DEPOT], restaurants: ALL } }) };
}
const ROUND = [{ park: 300 }, { to: A }, { park: 300 }, { to: X }, { to: B }, { park: 300 }, { to: D }, { park: 240 }, { to: C }, { park: 300 },
  { to: M(5180, 0) }, { crawl: 300, metres: 45 }, { to: M(7000, 0) }, { park: 300 }];
const stopAt = (r, name) => r.segments.find((s) => s.kind === 'stop' && ((s.place && s.place.name === name) || (s.passedBy && s.passedBy.name === name)));

test('customers passed on the way with no order are nothing at all', () => {
  const { r, j } = run(day(ROUND));
  assert.equal(stopAt(r, 'Restaurant X'), undefined, 'no stop at X');
  assert.ok(!j.notInPlan.some((x) => x.placeName === 'Restaurant X'));
  assert.equal(j.totals.missedDeliveries, 0);
});

test('a forgotten restaurant visited 4 min is counted as a visit and put in front of the office to check', () => {
  const { r, j } = run(day(ROUND));
  const d = stopAt(r, 'Restaurant D');
  assert.equal(d.type, 'LIKELY_RESTAURANT_VISIT');
  assert.equal(d.notInPlan, true);
  assert.equal(d.needsReview, true, 'in the review queue');
  assert.ok(d.evidence.some((e) => e.code === 'not_in_plan_visit' && /4 min parked at Restaurant D/.test(e.detail)));
  const card = j.notInPlan.find((x) => x.placeName === 'Restaurant D');
  assert.equal(card.kind, 'visited');
  assert.equal(card.check, true);
  assert.equal(d.motion.pattern, 'still');
});

test('5 min crawling in a jam beside a restaurant not on the round is slow traffic, not a visit', () => {
  const { r, j } = run(day(ROUND));
  const g = stopAt(r, 'Restaurant G');
  assert.equal(g.place, null, 'not a restaurant visit');
  assert.equal(g.passedBy.traffic, true);
  assert.equal(g.motion.pattern, 'crawl');
  assert.ok(g.evidence.some((e) => e.code === 'slow_traffic' && /5 min in slow traffic beside Restaurant G/.test(e.detail)));
  assert.equal(g.transit, true, 'a pause on the way');
  const card = j.notInPlan.find((x) => x.placeName === 'Restaurant G');
  assert.equal(card.kind, 'traffic');
  assert.match(j.stops.find((s) => s.passedBy && s.passedBy.name === 'Restaurant G').label, /Slow traffic by Restaurant G/);
  assert.ok(!r.visits.some((v) => v.placeId === 'G'));
});

test('crawling at a PLANNED restaurant stays the visit, and is flagged', () => {
  const steps = [{ park: 300 }, { to: M(1480, 0) }, { crawl: 300, metres: 45 }, { to: B }, { park: 300 }];
  const { r } = run(day(steps));
  const a = stopAt(r, 'Restaurant A');
  assert.equal(a.type, 'LIKELY_RESTAURANT_VISIT');
  assert.equal(a.needsReview, true);
  assert.ok(a.evidence.some((e) => e.code === 'looked_like_traffic'));
});

test('a parked phone wandering indoors is not mistaken for traffic', () => {
  const steps = [{ park: 300 }, { to: D }, { park: 600, wander: 30 }, { to: C }, { park: 300 }];
  const { r } = run(day(steps));
  const d = stopAt(r, 'Restaurant D');
  assert.equal(d.motion.pattern, 'still');
  assert.equal(d.type, 'LIKELY_RESTAURANT_VISIT');
});

test('a long jam at no known place is a pause on the way however long it lasts', () => {
  const steps = [{ park: 300 }, { to: M(2000, 0) }, { crawl: 900, metres: 50 }, { to: B }, { park: 300 }];
  const { r } = run(day(steps));
  const jam = r.segments.find((s) => s.kind === 'stop' && s.motion && s.motion.pattern === 'crawl');
  assert.ok(jam, 'the jam is a stop');
  assert.ok(jam.dwellSec > 600, 'longer than the 10-minute pause limit');
  assert.equal(jam.transit, true);
});

test('motion: parked noise is still; steady creep is crawl', () => {
  const pts = (fn) => Array.from({ length: 12 }, (_, i) => ({ ...fn(i), deviceTs: T0 + i * 30000, accuracyM: 8, speedMps: 0 }));
  assert.equal(motionOf(pts(() => M(0, 0))).pattern, 'still');
  assert.equal(motionOf(pts((i) => M(i * 5, 0))).pattern, 'crawl');
});
