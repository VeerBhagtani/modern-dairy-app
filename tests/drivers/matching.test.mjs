// Delivery matching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { PLACES } from './helpers/journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { resolveConfig } = require('./src/drivers/config');
const { matchDeliveries, OUTCOME } = require('./src/drivers/matching');
const { SEGMENT_TYPE } = require('./src/drivers/classification');
const manual = require('./src/services/orderSource/manual');

const { config: CFG } = resolveConfig();
const T0 = Date.parse('2026-09-15T04:00:00Z');

function visit(id, place, at, dwellSec = 600) {
  return {
    id,
    kind: 'stop',
    type: SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT,
    startTs: at,
    endTs: at + dwellSec * 1000,
    place: { id: place.id, name: place.name, customerId: place.customerId, kind: 'restaurant' },
    stop: { center: { lat: place.lat, lng: place.lng }, dwellSec },
  };
}
const RESTAURANTS = [PLACES.RESTAURANT_A, PLACES.RESTAURANT_B];
const CTX = { driverId: 'drv1' };

test('a visit inside the delivery window for the right driver is MATCHED', () => {
  const segs = [visit('seg_0001', PLACES.RESTAURANT_A, T0)];
  const orders = [{ id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv1', placeId: 'res_a', windowStart: T0 - 600000, windowEnd: T0 + 3600000 }];
  const out = matchDeliveries(segs, orders, RESTAURANTS, CTX, CFG);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].outcome, OUTCOME.MATCHED);
  assert.equal(out.matches[0].confidence, 'HIGH');
  assert.ok(out.matches[0].evidence.some((e) => e.code === 'time_match'));
});

test('a visit outside the window but inside the tolerance is only POSSIBLE', () => {
  const segs = [visit('seg_0001', PLACES.RESTAURANT_A, T0 + 3600000)];
  const orders = [{ id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv1', placeId: 'res_a', windowStart: T0, windowEnd: T0 + 600000 }];
  const out = matchDeliveries(segs, orders, RESTAURANTS, CTX, CFG);
  assert.equal(out.matches[0].outcome, OUTCOME.POSSIBLE);
});

test('proximity alone never makes a match — the customer has to agree', () => {
  const segs = [visit('seg_0001', PLACES.RESTAURANT_A, T0)];
  // An order for a DIFFERENT customer, at the same moment.
  const orders = [{ id: 'o1', customerId: 'CUST-Z', assignedDriverId: 'drv1', windowStart: T0, windowEnd: T0 + 3600000 }];
  const out = matchDeliveries(segs, orders, RESTAURANTS, CTX, CFG);
  assert.equal(out.matches.length, 0);
  assert.equal(out.unmatchedVisits.length, 1);
  assert.equal(out.unmatchedOrders.length, 1);
});

test("an order assigned to another driver is flagged, not quietly matched", () => {
  const segs = [visit('seg_0001', PLACES.RESTAURANT_A, T0)];
  const orders = [{ id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv_other', placeId: 'res_a', windowStart: T0, windowEnd: T0 + 3600000 }];
  const out = matchDeliveries(segs, orders, RESTAURANTS, CTX, CFG);
  assert.equal(out.matches[0].outcome, OUTCOME.NEEDS_REVIEW);
  assert.ok(out.matches[0].evidence.some((e) => e.code === 'driver_mismatch'));
});

test('one order can satisfy only one visit', () => {
  const segs = [visit('seg_0001', PLACES.RESTAURANT_A, T0), visit('seg_0003', PLACES.RESTAURANT_A, T0 + 5400000)];
  const orders = [{ id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv1', placeId: 'res_a', windowStart: T0, windowEnd: T0 + 3600000 }];
  const out = matchDeliveries(segs, orders, RESTAURANTS, CTX, CFG);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].segmentId, 'seg_0001', 'the closer visit in time should take the order');
  assert.equal(out.unmatchedVisits.length, 1);
});

test('several orders to one address share one visit and one set of kilometres', () => {
  const segs = [visit('seg_0001', PLACES.RESTAURANT_A, T0)];
  const orders = [
    { id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv1', placeId: 'res_a', windowStart: T0, windowEnd: T0 + 3600000 },
    { id: 'o2', customerId: 'CUST-A', assignedDriverId: 'drv1', placeId: 'res_a', windowStart: T0, windowEnd: T0 + 3600000 },
  ];
  const out = matchDeliveries(segs, orders, RESTAURANTS, CTX, CFG);
  assert.equal(out.matches.length, 2);
  assert.equal(new Set(out.matches.map((m) => m.segmentId)).size, 1);
  assert.match(out.summary.distanceNote, /per visit, never per order/);
});

test('an order with no visit is reported as an unmatched delivery', () => {
  const out = matchDeliveries([], [{ id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv1', windowStart: T0, windowEnd: T0 + 600000 }], RESTAURANTS, CTX, CFG);
  assert.equal(out.unmatchedOrders.length, 1);
  assert.equal(out.unmatchedOrders[0].outcome, OUTCOME.UNMATCHED_DELIVERY);
});

test('with no order data at all, a visit says so rather than implying wrongdoing', () => {
  const out = matchDeliveries([visit('seg_0001', PLACES.RESTAURANT_A, T0)], [], RESTAURANTS, CTX, CFG);
  assert.equal(out.unmatchedVisits.length, 1);
  assert.match(out.unmatchedVisits[0].reason, /no order data/);
});

test('a cancelled order never matches silently', () => {
  const segs = [visit('seg_0001', PLACES.RESTAURANT_A, T0)];
  const orders = [{ id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv1', placeId: 'res_a', windowStart: T0, windowEnd: T0 + 3600000, status: 'cancelled' }];
  const out = matchDeliveries(segs, orders, RESTAURANTS, CTX, CFG);
  assert.equal(out.matches[0].outcome, OUTCOME.NEEDS_REVIEW);
});

test('matching is deterministic', () => {
  const segs = [visit('seg_0001', PLACES.RESTAURANT_A, T0), visit('seg_0002', PLACES.RESTAURANT_B, T0 + 3600000)];
  const orders = [
    { id: 'o2', customerId: 'CUST-B', assignedDriverId: 'drv1', placeId: 'res_b', windowStart: T0, windowEnd: T0 + 7200000 },
    { id: 'o1', customerId: 'CUST-A', assignedDriverId: 'drv1', placeId: 'res_a', windowStart: T0, windowEnd: T0 + 7200000 },
  ];
  const a = matchDeliveries(segs, orders, RESTAURANTS, CTX, CFG);
  const b = matchDeliveries(segs, [...orders].reverse(), RESTAURANTS, CTX, CFG);
  assert.deepEqual(a.matches.map((m) => [m.segmentId, m.orderId]), b.matches.map((m) => [m.segmentId, m.orderId]));
});

// ── CSV order import ──────────────────────────────────────────────────────

test('the order CSV parser reads quoted fields and IST times correctly', () => {
  const csv = 'order_id,customer_id,driver_code,ordered_at,window_start,window_end,status\n'
    + 'SO-1,"CUST-A",MD-014,2026-09-15 08:00,2026-09-15 09:00,2026-09-15 11:00,dispatched\n'
    + 'SO-2,CUST-B,,2026-09-15T10:30:00+05:30,,,pending\n';
  const { orders, problems } = manual.parseOrdersCsv(csv, new Map([['MD-014', 'driver-uuid-1']]));
  assert.equal(orders.length, 2);
  assert.equal(orders[0].customerId, 'CUST-A');
  assert.equal(orders[0].assignedDriverId, 'driver-uuid-1');
  // 08:00 IST is 02:30 UTC — reading it as UTC would shift every window.
  assert.equal(new Date(orders[0].orderedAt).toISOString(), '2026-09-15T02:30:00.000Z');
  assert.equal(orders[1].assignedDriverId, null);
  assert.equal(problems.length, 0);
});

test('an unknown driver code is reported, never guessed', () => {
  const csv = 'order_id,customer_id,driver_code\nSO-9,CUST-A,MD-999\n';
  const { orders, problems } = manual.parseOrdersCsv(csv, new Map());
  assert.equal(orders[0].assignedDriverId, null);
  assert.match(problems[0], /MD-999/);
});

test('a comma inside a quoted restaurant name does not shift the columns', () => {
  const rows = manual.parseCsv('name,lat\n"Kamat, Deccan",18.51\n');
  assert.deepEqual(rows[1], ['Kamat, Deccan', '18.51']);
});

test('the order source layer refuses an order it cannot match', () => {
  const { validateOrder } = require('./src/services/orderSource');
  assert.deepEqual(validateOrder({ externalId: 'x', customerId: 'c', orderedAt: T0 }), []);
  assert.match(validateOrder({ externalId: 'x', orderedAt: T0 }).join(), /customerId/);
  assert.match(validateOrder({ externalId: 'x', customerId: 'c' }).join(), /orderedAt|windowStart/);
});
