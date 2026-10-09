// The 2-minute rule: during a ride, a restaurant counts as delivered only if
// the driver stayed at least 2 minutes. Shorter is a missed delivery — named,
// not silently dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { processRideData } = require('./src/drivers/pipeline');
const { buildReplay } = require('./src/services/replay');
const { buildJourney } = require('./src/drivers/journey');
const { resolveConfig } = require('./src/drivers/config');
const { haversineM } = require('./src/drivers/geo');

const T0 = Date.parse('2026-10-09T03:00:00Z');
const M = (dx, dy) => ({ lat: 18.50 + dy / 111320, lng: 73.86 + dx / (111320 * Math.cos(18.5 * Math.PI / 180)) });
const DEPOT = { id: 'depot', name: 'Modern Dairy', ...M(0, 0), radiusM: 150 };
const A = { id: 'A', name: 'Restaurant A', customerId: 'CA', ...M(2000, 0), radiusM: 80 };
const B = { id: 'B', name: 'Restaurant B', customerId: 'CB', ...M(2000, 1500), radiusM: 80 };

// Stops: { at, dwellSec }; driving at 8 m/s with a fix every 10 s.
function day(stops) {
  const pts = []; let t = T0; let n = 0; let here = stops[0].at;
  const fix = (p, sp) => { pts.push({ clientPointId: `p${n += 1}`, lat: p.lat, lng: p.lng, deviceTs: t, accuracyM: 8, speedMps: sp }); t += 10000; };
  for (const s of stops) {
    const steps = Math.max(1, Math.round(haversineM(here, s.at) / 80));
    for (let k = 1; k <= steps; k += 1) fix({ lat: here.lat + (s.at.lat - here.lat) * k / steps, lng: here.lng + (s.at.lng - here.lng) * k / steps }, 8);
    for (let k = 0; k < s.dwellSec / 10; k += 1) fix(s.at, 0);
    here = s.at;
  }
  return pts;
}
const ride = (plan) => ({ id: 'r', driverId: 'd', startedAt: T0, status: 'completed', plannedStops: plan || [] });
const plan = [{ placeId: 'A', plannedAt: T0 - 60000 }, { placeId: 'B', plannedAt: T0 - 60000 }];
function run(points, overrides, r) {
  return processRideData({ points, ride: r || ride(plan), facilities: [DEPOT], restaurants: [A, B], orders: [], declarations: [], reviews: [], configOverrides: overrides, nowMs: T0 + 864e5 });
}

test('50 seconds at a planned restaurant is a missed delivery, with the reason', () => {
  const pts = day([{ at: DEPOT, dwellSec: 300 }, { at: A, dwellSec: 300 }, { at: B, dwellSec: 50 }, { at: DEPOT, dwellSec: 300 }]);
  const r = run(pts);
  assert.equal(r.shortVisits.length, 1);
  assert.equal(r.shortVisits[0].placeId, 'B');
  assert.ok(r.shortVisits[0].dwellSec >= 40 && r.shortVisits[0].dwellSec < 120);
  const missed = r.matching.unmatchedOrders.find((o) => o.placeId === 'B');
  assert.ok(missed, 'B is missed');
  assert.equal(missed.missedReason, 'too_short');
  assert.match(missed.reason, /stopped only \d+ s at Restaurant B — under the 2-minute minimum/);
  assert.ok(r.matching.matches.some((m) => m.placeId === 'A' && m.outcome === 'MATCHED'), 'A (5 min) is delivered');
  // Shown on the journey, in order, and counted.
  const j = buildJourney({ ride: ride(plan), processing: { ...r, processedAt: T0 + 864e5 }, replay: buildReplay(pts, { ...r, processedAt: T0 + 864e5 }), places: { facilities: [DEPOT], restaurants: [A, B] } });
  const ev = j.events.find((e) => e.kind === 'missed');
  assert.equal(ev.label, 'Restaurant B');
  assert.equal(j.totals.missedDeliveries, 1);
  assert.ok(!j.stops.some((s) => s.placeId === 'B' && s.category === 'RESTAURANT'), 'never a visit');
});

test('2 minutes or more is a delivery; driving past at speed is nothing', () => {
  const ok = run(day([{ at: DEPOT, dwellSec: 300 }, { at: A, dwellSec: 130 }, { at: B, dwellSec: 300 }]));
  assert.equal(ok.shortVisits.length, 0);
  assert.equal(ok.matching.unmatchedOrders.length, 0);
  // Depot → past A without stopping → B.
  const past = run(day([{ at: DEPOT, dwellSec: 300 }, { at: M(4000, 0), dwellSec: 0 }, { at: B, dwellSec: 300 }]));
  assert.ok(!past.shortVisits.some((v) => v.placeId === 'A'), 'passing through a geofence at road speed is not a halt');
  const a = past.matching.unmatchedOrders.find((o) => o.placeId === 'A');
  assert.equal(a.missedReason, 'no_visit');
});

test('the minimum cannot be set below 2 minutes', () => {
  const r = resolveConfig({ visitMinDwellSec: 60 });
  assert.equal(r.config.visitMinDwellSec, 120);
  assert.ok(r.rejected.some((x) => x.key === 'visitMinDwellSec'));
});

test('if stops are set shorter than 2 min, a short restaurant stop is a missed delivery, not a visit', () => {
  const pts = day([{ at: DEPOT, dwellSec: 300 }, { at: A, dwellSec: 90 }, { at: DEPOT, dwellSec: 300 }]);
  const r = run(pts, { stopMinDwellSec: 60 });
  const stop = r.segments.find((s) => s.kind === 'stop' && s.place && s.place.id === 'A');
  assert.ok(stop);
  assert.equal(stop.missedDelivery, true);
  assert.equal(stop.type, 'UNKNOWN', 'not business');
  assert.ok(stop.evidence.some((e) => e.code === 'too_short_for_delivery'));
  const j = buildJourney({ ride: ride(plan), processing: { ...r, processedAt: T0 + 864e5 }, replay: buildReplay(pts, { ...r, processedAt: T0 + 864e5 }), places: { facilities: [DEPOT], restaurants: [A, B] } });
  assert.equal(j.stops.find((s) => s.placeId === 'A').category, 'MISSED');
});

test('the driver app ticks a stop only after 2 minutes there, and counts down', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app/www/app.js'), 'utf8');
  assert.match(app, /var DELIVERY_MIN_MS = 120000;/);
  assert.match(app, /if \(t - s\.arrivedAt >= DELIVERY_MIN_MS\) \{ s\.done = true;/);
  assert.match(app, /Leaving sooner is a missed delivery\./);
});
