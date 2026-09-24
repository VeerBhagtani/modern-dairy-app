// Report building, export formatting and roll-ups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { fullDayJourney, FACILITIES, RESTAURANTS } from './helpers/journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const reports = require('./src/drivers/reports');
const { processRideData, aggregateRides } = require('./src/drivers/pipeline');

const POINTS = fullDayJourney({ seed: 11, gapAfterWaypoint: 4 });
const NOW = POINTS[POINTS.length - 1].deviceTs + 60000;
const RESULT = processRideData({
  points: POINTS, ride: { id: 'r1', driverId: 'd1' },
  facilities: FACILITIES, restaurants: RESTAURANTS,
  orders: [], declarations: [], reviews: [], nowMs: NOW,
});
const ROWS = [{
  ride: { id: 'r1', driverId: 'd1', dayKey: '2026-09-15' },
  result: RESULT,
  driver: { id: 'd1', name: 'Ramesh Patil', driverCode: 'MD-014' },
}];

test('CSV quoting survives commas, quotes and newlines', () => {
  const csv = reports.toCsv(
    [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
    [{ a: 'Kamat, Deccan', b: 'He said "hi"\nthen left' }],
  );
  assert.ok(csv.includes('"Kamat, Deccan"'));
  assert.ok(csv.includes('"He said ""hi""'));
});

test('CSV neutralises formula injection', () => {
  // A restaurant named "=HYPERLINK(...)" must not become a live formula the
  // moment somebody opens the export in Excel.
  for (const payload of ['=cmd|calc', '+1+1', '-2+3', '@SUM(A1)']) {
    const csv = reports.toCsv([{ key: 'n', label: 'name' }], [{ n: payload }]);
    assert.ok(csv.includes(`'${payload}`) || csv.includes(`"'${payload}`),
      `${payload} was not neutralised: ${csv}`);
  }
});

test('CSV starts with a BOM so Excel reads Devanagari and accents correctly', () => {
  const csv = reports.toCsv([{ key: 'n', label: 'name' }], [{ n: 'शिवाजी' }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
});

test('the Excel export is a real worksheet, and escapes markup', () => {
  const xml = reports.toExcelXml('Distance', [{ key: 'n', label: 'name' }, { key: 'k', label: 'km' }], [{ n: 'A & <B>', k: 12.3 }]);
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('<Worksheet ss:Name="Distance">'));
  assert.ok(xml.includes('A &amp; &lt;B&gt;'));
  // Numbers are typed as numbers, so the spreadsheet can sum a column.
  assert.ok(xml.includes('ss:Type="Number">12.3'));
});

test('the driver distance report carries every bucket and its provenance', () => {
  const rows = reports.driverDistanceRows(ROWS);
  assert.equal(rows.length, 1);
  const r = rows[0];
  for (const k of ['verifiedBusinessKm', 'likelyBusinessKm', 'personalKm', 'unknownKm', 'gapKm', 'totalKm']) {
    assert.equal(typeof r[k], 'number', `${k} missing`);
  }
  assert.equal(r.calcVersion, RESULT.calcVersion);
  assert.ok(r.quality);
  // The report's own columns must cover what the rows carry.
  const cols = reports.REPORTS.driver_distance.columns.map((c) => c.key);
  for (const k of Object.keys(r)) assert.ok(cols.includes(k), `column ${k} is not declared`);
});

test('the business-kilometre report states its basis on every row', () => {
  const rows = reports.businessKmRows(ROWS);
  assert.match(rows[0].basis, /HIGH-confidence/);
  assert.match(rows[0].basis, /Unknown is excluded/);
});

test('the restaurant-visit report shows confidence and match outcome, not just a count', () => {
  const rows = reports.restaurantVisitRows(ROWS);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.ok(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(r.confidence));
    assert.equal(r.matchOutcome, 'UNMATCHED_VISIT');   // no order data in this fixture
    assert.ok(r.arrivedAtIst.endsWith('IST'));
  }
});

test('the matching report lists unmatched visits and orders, not only the matches', () => {
  const withOrder = processRideData({
    points: POINTS, ride: { id: 'r1', driverId: 'd1' },
    facilities: FACILITIES, restaurants: RESTAURANTS,
    orders: [{ id: 'SO-9', customerId: 'CUST-Z', assignedDriverId: 'd1', orderedAt: POINTS[0].deviceTs, windowStart: POINTS[0].deviceTs, windowEnd: NOW }],
    declarations: [], reviews: [], nowMs: NOW,
  });
  const rows = reports.deliveryMatchingRows([{ ride: { id: 'r1', driverId: 'd1', dayKey: '2026-09-15' }, result: withOrder, driver: null }]);
  assert.ok(rows.some((r) => r.outcome === 'UNMATCHED_DELIVERY'));
  assert.ok(rows.some((r) => r.outcome === 'UNMATCHED_VISIT'));
});

test('the reliability report exposes the gap, not just a grade', () => {
  const rows = reports.gpsReliabilityRows(ROWS);
  assert.equal(rows[0].points, RESULT.track.totals.rawCount);
  assert.ok(rows[0].gapCount >= 1);
  assert.ok(rows[0].gapMinutes >= 5);
});

test('the anomaly report reports the gap and any long leg that went to no restaurant', () => {
  const rows = reports.routeAnomalyRows(ROWS);
  assert.ok(rows.some((r) => r.kind === 'tracking_gap'));
  // The Porter detour in the fixture is several kilometres that lead to no
  // customer: personal by rule, and shown so the office can check it.
  assert.ok(rows.some((r) => r.kind === 'large_personal_leg'));
});

test('the classification audit report renders the full chain', () => {
  const rows = reports.classificationAuditRows(
    [{ id: 'rev1', rideId: 'r1', segmentId: 'seg_0005', fromType: 'UNKNOWN', toType: 'PERSONAL_OR_NON_BUSINESS', distanceM: 3400, note: 'Porter', reviewerId: 'admin:owner', at: NOW, reverted: false }],
    new Map([['d1', { name: 'Ramesh Patil' }]]),
    new Map([['r1', { driverId: 'd1', dayKey: '2026-09-15' }]]),
  );
  assert.equal(rows[0].driverName, 'Ramesh Patil');
  assert.equal(rows[0].distanceKm, 3.4);
  assert.equal(rows[0].fromType, 'UNKNOWN');
});

test('period roll-ups sum metres, not rounded kilometres', () => {
  // Ten days of 0.44 km each: summing rounded values would give 0 or 5.0;
  // summing metres gives the right answer.
  const fake = Array.from({ length: 10 }, () => ({
    driverId: 'd1',
    distance: { metres: { verifiedBusiness: 440, likelyBusiness: 0, personal: 0, unknown: 0, invalid: 0, gapEstimate: 0, measured: 440, dayTotal: 440 } },
    counts: { restaurantVisits: 1 },
    matching: { summary: { matched: 0, unmatchedVisits: 1, unmatchedOrders: 0 } },
    review: { pending: 0 },
    visits: [],
  }));
  const agg = aggregateRides(fake);
  assert.equal(agg.metres.verifiedBusiness, 4400);
  assert.equal(agg.km.verifiedBusiness, 4.4);
  assert.equal(agg.rides, 10);
});

test('roll-ups break down by driver and by restaurant', () => {
  const agg = aggregateRides([RESULT]);
  assert.equal(agg.perDriver.length, 1);
  assert.equal(agg.perDriver[0].driverId, 'd1');
  assert.equal(agg.perPlace.length, 4);
  assert.ok(agg.perPlace.every((p) => p.approachKm > 0));
  assert.ok(agg.averageKmPerVisit > 0);
});
