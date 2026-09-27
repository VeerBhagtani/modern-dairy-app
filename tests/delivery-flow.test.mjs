// Delivery matching from a real-looking back-office export to the ride's
// result: the file the office actually has, not the one the code expected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const manual = require('./src/services/orderSource/manual');
const { validateOrder, affectedDays } = require('./src/services/orderSource');
const { processRideData } = require('./src/drivers/pipeline');
const { customerKey, orderWindow } = require('./src/drivers/orderWindow');

const T0 = Date.parse('2026-09-25T04:00:00Z');   // 09:30 IST
const R = { id: 'R', name: 'Hotel Shreyas', customerId: '00123', lat: 18.52, lng: 73.85, radiusM: 80 };

function morningVisit() {
  const pts = [];
  for (let i = 0; i <= 20; i += 1) pts.push({ clientPointId: `p:${i}`, lat: R.lat - 0.02 + i * 0.001, lng: R.lng, deviceTs: T0 + i * 20000, accuracyM: 8 });
  for (let i = 1; i <= 12; i += 1) pts.push({ clientPointId: `s:${i}`, lat: R.lat, lng: R.lng, deviceTs: T0 + 400000 + i * 20000, accuracyM: 8 });
  return pts;
}

// Excel dropped the leading zeros, the bill was made the evening before, the
// driver is written by name, and the headers are the back office's own.
const CSV = 'Bill No,Party Code,Bill Date,Driver Name,Amount\n'
  + 'B-501,123,24/09/2026 9:15 PM,Ramesh,1450\n'
  + 'B-502,999,25/09/2026,Ramesh,300\n'
  + 'B-503,123,25-09-2026 10:05,Nobody,80\n';

test('a back-office export is read: aliases, day-first dates, names, Excel-mangled codes', () => {
  const { orders, problems } = manual.parseOrdersCsv(CSV, new Map([['MD-001', 'drv']]), new Map([['Ramesh', 'drv']]));
  assert.equal(orders.length, 3);
  assert.equal(orders[0].externalId, 'B-501');
  assert.equal(orders[0].customerId, '123');
  assert.equal(orders[0].assignedDriverId, 'drv', 'by name');
  assert.equal(new Date(orders[0].orderedAt + 19800000).toISOString().slice(0, 16), '2026-09-24T21:15');
  assert.equal(orders[1].orderedDateOnly, true);
  assert.equal(orders[2].assignedDriverId, null);
  assert.match(problems.join(), /driver "Nobody" does not match/);
  for (const o of orders) assert.deepEqual(validateOrder(o), [], o.externalId);
  assert.deepEqual(affectedDays(orders), ['2026-09-24', '2026-09-25', '2026-09-26']);
});

test('the evening-before bill matches the morning visit and verifies it', () => {
  const { orders } = manual.parseOrdersCsv(CSV, new Map(), new Map([['Ramesh', 'drv']]));
  const withIds = orders.map((o) => ({ ...o, id: `manual_${o.externalId}` }));
  const r = processRideData({ points: morningVisit(), ride: { id: 'x', driverId: 'drv', startedAt: T0 }, facilities: [], restaurants: [R],
    orders: withIds, declarations: [], reviews: [], nowMs: T0 + 864e5 });
  const visit = r.segments.find((s) => s.type === 'LIKELY_RESTAURANT_VISIT');
  assert.ok(visit);
  assert.equal(visit.confidence, 'HIGH', 'corroborated by the order');
  const m = r.matching.matches.find((x) => x.orderId === 'manual_B-501');
  assert.ok(m, 'B-501 matched');
  assert.equal(m.outcome, 'MATCHED');
  // B-503 is to the same customer, unassigned, and the same visit covers it.
  assert.ok(r.matching.matches.some((x) => x.orderId === 'manual_B-503'));
  // B-502 is this driver's, to a customer never visited: reported.
  assert.deepEqual(r.matching.unmatchedOrders.map((o) => o.orderId), ['manual_B-502']);
  assert.equal(r.distance.reconciliation.ok, true);
});

test('another driver\'s orders are not listed as this ride\'s unmatched deliveries', () => {
  const others = Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, customerId: `C${i}`, orderedAt: T0, assignedDriverId: 'someone-else' }));
  const r = processRideData({ points: morningVisit(), ride: { id: 'x', driverId: 'drv', startedAt: T0 }, facilities: [], restaurants: [R],
    orders: others, declarations: [], reviews: [], nowMs: T0 + 864e5 });
  assert.equal(r.matching.unmatchedOrders.length, 0);
});

test('customer codes and delivery windows', () => {
  assert.equal(customerKey('00123'), customerKey(123));
  assert.equal(customerKey('123.0'), '123');
  assert.equal(customerKey(' c-12 '), 'C-12');
  assert.notEqual(customerKey('C12'), customerKey('C-12'), 'no guessing beyond case, spaces and zeros');
  assert.equal(customerKey(''), null);
  const evening = Date.parse('2026-09-24T21:15:00+05:30');
  const w = orderWindow({ orderedAt: evening });
  assert.equal(w.end, Date.parse('2026-09-25T23:59:59.999+05:30'), 'an evening order runs to the end of the next day');
  const morning = Date.parse('2026-09-25T08:00:00+05:30');
  assert.equal(orderWindow({ orderedAt: morning }).end, Date.parse('2026-09-25T23:59:59.999+05:30'));
  assert.deepEqual(orderWindow({ windowStart: 1, windowEnd: 5, orderedAt: 0 }), { start: 1, end: 5 });
  assert.deepEqual(orderWindow({ deliveredAt: 7 }), { start: 7, end: 7 });
  assert.equal(orderWindow({}), null);
});

test('an upload recalculates the rides it affects', async () => {
  const fs = await import('fs');
  const src = fs.readFileSync(path.join(ROOT, 'backend/src/services/orderSource/index.js'), 'utf8');
  assert.match(src, /const ridesToRecalculate = days\.length \? await repo\(\)\.markDaysChanged\(days\) : 0;/);
  const admin = fs.readFileSync(path.join(ROOT, 'backend/src/routes/admin.js'), 'utf8');
  assert.match(admin, /bringUpToDate\(snap\.docs\.map[\s\S]{0,80}maxRides: 40/);
  const fresh = require('./src/services/freshness');
  const ride = { pointCount: 10, processedAt: 100, processedInputsAt: 100, status: 'completed', inputsChangedAt: 200 };
  assert.equal(fresh.needsCalc(ride, 1000), true, 'marked rides are recalculated');
  const views = fs.readFileSync(path.join(ROOT, 'dashboard/views.js'), 'utf8');
  assert.ok(views.includes('id="ordFile" accept=".csv,.xlsx,text/csv"'), 'Excel accepted for orders');
  assert.match(views, /window\.DRIVERS_XLSX\.readWorkbook\)\.then\(window\.DRIVERS_XLSX\.toCsv\)[\s\S]{0,200}API\.importOrders/);
});
