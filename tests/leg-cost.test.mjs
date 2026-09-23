// What it costs THIS driver to get from A to B.
//
// The point of this module is that forty drivers do not share one road
// network. A driver who knows the back gate covers less ground than Google
// thinks is possible, and the system should end up believing the driver, not
// the map — but only once it has seen enough to be sure, and never on the
// strength of one strange afternoon.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const lc = require_(path.join(ROOT, 'backend/src/drivers/legCost.js'));

const obs = (distanceM, durationS, at = Date.now()) => ({ distanceM, durationS, at });

test('a leg has a direction', () => {
  assert.notEqual(lc.legKey('a', 'b'), lc.legKey('b', 'a'));
});

test('one strange trip does not move the estimate', () => {
  // The driver stopped for lunch on one of these. A mean would add a kilometre
  // and a half to every future plan; the median ignores it entirely.
  const s = lc.summarise([obs(2000, 400), obs(2100, 420), obs(9000, 3000), obs(1950, 390)]);
  assert.equal(s.distanceM, 2050);
  assert.ok(s.durationS < 500, 'the lunch break must not reach the duration either');
});

test('a leg nobody has driven recently is forgotten, not averaged in', () => {
  const old = Date.now() - lc.MAX_AGE_MS - 1;
  assert.equal(lc.summarise([obs(2000, 400, old)]), null);
  assert.equal(lc.summarise([]), null);
  assert.equal(lc.summarise(undefined), null);
});

test('nonsense observations are dropped rather than trusted', () => {
  assert.equal(lc.summarise([obs(0, 0), obs(-5, 10), { distanceM: 'x', durationS: 1 }]), null);
});

// ── believing the driver, in proportion to the evidence ──────────────────────

test('with nothing recorded, the prior stands', () => {
  const out = lc.blend(null, { distanceM: 3000, durationS: 600, source: 'road-api' });
  assert.equal(out.distanceM, 3000);
  assert.equal(out.confidence, 'prior');
  assert.equal(out.runs, 0);
});

test('with enough runs, the driver wins outright', () => {
  // Google says three kilometres. This driver does it in two, five times over.
  // The plan should be built on two.
  const own = { runs: lc.FULL_TRUST_RUNS, distanceM: 2000, durationS: 300 };
  const out = lc.blend(own, { distanceM: 3000, durationS: 600 });
  assert.equal(out.distanceM, 2000);
  assert.equal(out.confidence, 'driver');
});

test('one run moves the estimate part of the way, not all of it', () => {
  // A single trip is real evidence and should count — but not enough to throw
  // the map away on, in case that trip was unusual in a way nobody recorded.
  const out = lc.blend({ runs: 1, distanceM: 2000, durationS: 300 }, { distanceM: 3000, durationS: 600 });
  assert.ok(out.distanceM > 2000 && out.distanceM < 3000, 'it must sit between the two');
  assert.equal(out.confidence, 'learning');
  // One run out of five means one fifth of the way.
  assert.equal(out.distanceM, 3000 - (1000 / lc.FULL_TRUST_RUNS));
});

test('more runs move it further', () => {
  const one = lc.blend({ runs: 1, distanceM: 2000, durationS: 300 }, { distanceM: 3000, durationS: 600 });
  const three = lc.blend({ runs: 3, distanceM: 2000, durationS: 300 }, { distanceM: 3000, durationS: 600 });
  assert.ok(three.distanceM < one.distanceM, 'evidence should accumulate towards the driver');
});

// ── building the table ───────────────────────────────────────────────────────

const STOPS = [
  { id: 'D', lat: 18.5139, lng: 73.8773 },
  { id: 'A', lat: 18.5200, lng: 73.8800 },
  { id: 'B', lat: 18.5300, lng: 73.8900 },
];

test('every leg in both directions gets a cost, always', () => {
  // Nothing is known about any of these, so the straight line has to cover it.
  // A plan that cannot be costed is a plan that cannot be made.
  const { table } = lc.buildCostTable(STOPS);
  for (const a of STOPS) {
    for (const b of STOPS) {
      if (a.id === b.id) continue;
      const leg = table[lc.legKey(a.id, b.id)];
      assert.ok(leg && leg.distanceM > 0, `${a.id}>${b.id} must have a cost`);
    }
  }
});

test('the straight line is inflated, because roads are not straight', () => {
  const { table } = lc.buildCostTable(STOPS);
  const leg = table[lc.legKey('D', 'A')];
  assert.ok(leg.distanceM > 700, 'a road distance below the crow-flies distance is impossible');
  assert.equal(leg.source, 'straight-line');
});

test('only the legs nobody knows anything about are worth paying to look up', () => {
  // This is what keeps the API bill from growing with the fleet: a leg the
  // driver has driven, or the fleet has driven, is never asked about.
  const { unknown } = lc.buildCostTable(STOPS, {
    learned: { 'D>A': [obs(1200, 240), obs(1250, 250)] },
    fleetPrior: { 'A>B': { distanceM: 1800, durationS: 300 } },
  });
  const asked = unknown.map((u) => `${u.from}>${u.to}`);
  assert.ok(!asked.includes('D>A'), 'the driver has driven this one');
  assert.ok(!asked.includes('A>B'), 'somebody in the fleet has driven this one');
  assert.ok(asked.includes('B>D'), 'nobody has driven this one');
});

test('the driver beats the fleet, and the fleet beats a guess', () => {
  const { table } = lc.buildCostTable(STOPS, {
    learned: { 'D>A': [obs(1000, 200), obs(1000, 200), obs(1000, 200), obs(1000, 200), obs(1000, 200)] },
    fleetPrior: { 'D>A': { distanceM: 5000, durationS: 900 }, 'A>B': { distanceM: 1800, durationS: 300 } },
    apiPrior: { 'A>B': { distanceM: 1700, durationS: 280 } },
  });
  assert.equal(table['D>A'].distanceM, 1000, 'this driver\'s own runs must win');
  assert.equal(table['A>B'].distanceM, 1700, 'the road network beats the fleet average');
  assert.equal(table['B>D'].source, 'straight-line', 'and a guess is the last resort');
});
