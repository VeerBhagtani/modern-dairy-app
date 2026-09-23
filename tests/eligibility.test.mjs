// Can a driver be sent to this restaurant today?
//
// This exists as one function because the question is asked in two places —
// the list the app offers, and the planner that builds a round — and the day
// they disagree is the day a driver reaches a restaurant the office had
// stopped supplying, by re-using yesterday's round. The tests below are mostly
// about that: hold means hold, everywhere, for every reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const { stopEligibility, canVisit, INELIGIBLE } = require_(path.join(ROOT, 'backend/src/drivers/eligibility.js'));

const shop = (extra = {}) => ({ id: 'r1', name: 'Hotel Sai', lat: 18.5, lng: 73.8, ...extra });

test('an ordinary restaurant can be visited', () => {
  assert.equal(canVisit(shop()), true);
  assert.deepEqual(stopEligibility(shop()), { ok: true });
});

test('supply on hold means no', () => {
  const v = stopEligibility(shop({ supplyHold: true, holdReason: 'payment overdue' }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, INELIGIBLE.ON_HOLD);
  assert.match(v.message, /payment overdue/, 'the driver is told why, not just refused');
});

test('a hold with no reason recorded still holds', () => {
  // The API requires a reason, but a row written before that rule existed
  // must not become visitable just because its reason is missing.
  const v = stopEligibility(shop({ supplyHold: true }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, INELIGIBLE.ON_HOLD);
});

test('only an explicit hold holds', () => {
  // Anything falsy, absent, or a stray string must not accidentally stop
  // supply to a paying customer.
  for (const supplyHold of [false, null, undefined, 0, '']) {
    assert.equal(canVisit(shop({ supplyHold })), true, `supplyHold=${JSON.stringify(supplyHold)}`);
  }
});

test('a held restaurant is refused even with a perfect location', () => {
  // The hold is a business decision, not a data problem; no amount of good
  // data overrides it.
  assert.equal(canVisit(shop({ supplyHold: true, lat: 18.5, lng: 73.8, active: true })), false);
});

test('a held restaurant with no location is reported as held, not as unplaced', () => {
  // "On hold" is the useful thing to tell somebody. "No location yet" would
  // send the office off to place a pin for a customer they have suspended.
  const v = stopEligibility({ id: 'r2', name: 'X', supplyHold: true, holdReason: 'shop shut' });
  assert.equal(v.reason, INELIGIBLE.ON_HOLD);
});

test('an inactive customer is refused, and said to be inactive', () => {
  const v = stopEligibility(shop({ active: false }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, INELIGIBLE.INACTIVE);
});

test('a restaurant nobody has placed cannot be routed to', () => {
  for (const coords of [{}, { lat: 18.5 }, { lat: 'x', lng: 'y' }, { lat: NaN, lng: 73.8 }]) {
    const v = stopEligibility({ id: 'r3', name: 'X', ...coords });
    assert.equal(v.ok, false);
    assert.equal(v.reason, INELIGIBLE.NO_LOCATION);
  }
});

test('a restaurant that does not exist is refused rather than crashing', () => {
  assert.equal(canVisit(null), false);
  assert.equal(canVisit(undefined), false);
});
