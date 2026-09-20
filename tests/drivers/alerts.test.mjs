// Operational alerts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { resolveConfig } = require('./src/drivers/config');
const { evaluateRideAlerts, evaluateResultAlerts, diffAlerts, ALERT } = require('./src/drivers/alerts');

const { config: CFG } = resolveConfig();
const NOW = Date.parse('2026-09-15T12:00:00Z');
const ride = (over = {}) => ({ id: 'r1', driverId: 'd1', status: 'active', startedAt: NOW - 3600000, lastPointAt: NOW - 30000, ...over });

test('a healthy active ride raises nothing', () => {
  assert.deepEqual(evaluateRideAlerts(ride(), CFG, NOW), []);
});

test('a stale position raises an info alert, a long silence a warning', () => {
  const stale = evaluateRideAlerts(ride({ lastPointAt: NOW - 240000 }), CFG, NOW);
  assert.equal(stale[0].kind, ALERT.LOCATION_STALE);
  assert.equal(stale[0].severity, 'info');

  const missing = evaluateRideAlerts(ride({ lastPointAt: NOW - 30 * 60000 }), CFG, NOW);
  assert.equal(missing[0].kind, ALERT.GPS_MISSING);
  assert.equal(missing[0].severity, 'warn');
});

test('a very long silence escalates to critical', () => {
  const a = evaluateRideAlerts(ride({ lastPointAt: NOW - 3 * 3600000, startedAt: NOW - 4 * 3600000 }), CFG, NOW);
  assert.equal(a[0].severity, 'critical');
});

test('a long-running ride warns before the hard auto-stop', () => {
  const a = evaluateRideAlerts(ride({ startedAt: NOW - 13 * 3600000 }), CFG, NOW);
  const long = a.find((x) => x.kind === ALERT.RIDE_TOO_LONG);
  assert.ok(long);
  assert.match(long.detail, /auto-close at 16 h/);
});

test('a stopped ride raises nothing at all', () => {
  assert.deepEqual(evaluateRideAlerts(ride({ status: 'stopped' }), CFG, NOW), []);
});

test('alerts never contain coordinates', () => {
  const all = [
    ...evaluateRideAlerts(ride({ lastPointAt: NOW - 30 * 60000, startedAt: NOW - 14 * 3600000 }), CFG, NOW),
    ...evaluateResultAlerts(ride(), {
      track: { gaps: [{ seconds: 2400, straightLineM: 5200 }] },
      matching: { summary: { unmatchedOrders: 2 } },
      review: { pending: 3, unknownKm: 12.4 },
    }, CFG),
  ];
  assert.ok(all.length >= 4);
  for (const a of all) {
    const json = JSON.stringify(a);
    assert.ok(!/\blat\b|\blng\b|latitude|longitude/i.test(json), `alert leaks a position: ${json}`);
    // A dispatcher still needs to know which driver and which ride.
    assert.ok(a.driverId && a.key);
  }
});

test('re-evaluating the same condition does not raise it twice', () => {
  const desired = evaluateRideAlerts(ride({ lastPointAt: NOW - 30 * 60000 }), CFG, NOW);
  const open = desired.map((a) => ({ ...a, id: 'existing' }));
  const diff = diffAlerts(desired, open);
  assert.equal(diff.toRaise.length, 0);
  assert.equal(diff.toResolve.length, 0);
});

test('a condition that has gone away is resolved', () => {
  const open = [{ id: 'x', key: `${ALERT.GPS_MISSING}|d1|`, kind: ALERT.GPS_MISSING }];
  const diff = diffAlerts([], open);
  assert.equal(diff.toResolve.length, 1);
  assert.equal(diff.toResolve[0].id, 'x');
});

test('result alerts name what needs review and how far it is', () => {
  const a = evaluateResultAlerts(ride(), {
    track: { gaps: [{ seconds: 2400, straightLineM: 5200 }] },
    matching: { summary: { unmatchedOrders: 2 } },
    review: { pending: 3, unknownKm: 12.4 },
  }, CFG);
  const review = a.find((x) => x.kind === ALERT.NEEDS_REVIEW);
  assert.match(review.detail, /12.4 km/);
  const gap = a.find((x) => x.kind === ALERT.LARGE_GAP);
  assert.match(gap.detail, /could only be estimated/);
});
