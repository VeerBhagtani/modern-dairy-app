// Customers that are not at an address.
//
// A food truck is a real customer that is not anywhere in particular. Pinning
// one to a street is worse than leaving it unpinned: the pin becomes a
// geofence in a place the truck may never park, so passing drivers register
// visits that did not happen and real deliveries register nothing.
//
// These tests pin both halves — what counts as a truck, and what must not be
// mistaken for one, because a wrongly-classified restaurant silently stops
// being tracked.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const mv = require_(path.join(ROOT, 'backend/src/drivers/mobileVendor.js'));

test('a truck is found in whichever column the office typed it', () => {
  assert.ok(mv.looksMobile({ name: 'Sai Food Truck' }));
  assert.ok(mv.looksMobile({ name: 'Sai Snacks', address: 'Food truck, FC Road' }));
  assert.ok(mv.looksMobile({ name: 'Sai Snacks', area: 'Truck parking, Hadapsar' }));
  assert.ok(mv.looksMobile({ address: 'TRUCK near Deccan' }), 'case must not matter');
  assert.ok(mv.looksMobile({ address: 'Two trucks by the bridge' }), 'plural counts');
});

test('a restaurant is not turned into a truck by a longer word', () => {
  // This is the expensive direction to get wrong: a misclassified restaurant
  // silently stops being located and stops being tracked.
  for (const row of [
    { name: 'Trucker Cafe' },
    { address: 'Trucking Estate Road, Hadapsar' },
    { name: 'Struck Gold Restaurant' },
    { address: 'Truckers Colony' },
  ]) {
    assert.ok(!mv.looksMobile(row), `${JSON.stringify(row)} must stay a restaurant`);
  }
});

test('an ordinary restaurant is left alone', () => {
  assert.ok(!mv.looksMobile({ name: 'Hotel Sai', address: '12 Paud Road', area: 'Kothrud' }));
  assert.ok(!mv.looksMobile({}));
  assert.ok(!mv.looksMobile());
});

test('a row already marked mobile is recognised however it was marked', () => {
  // Two paths lead here: detected at import, or moved by hand from the screen.
  assert.ok(mv.isMobile({ mobile: true }));
  assert.ok(mv.isMobile({ locationStatus: mv.MOBILE_STATUS }));
  assert.ok(!mv.isMobile({ mobile: false, locationStatus: 'pending' }));
  assert.ok(!mv.isMobile(null));
});

test('the mobile status is not one the lookup queue recognises', () => {
  // The whole point: it must not read as pending or unconfirmed, or the
  // location machinery will pick these up and start paying to geocode them.
  assert.notEqual(mv.MOBILE_STATUS, 'pending');
  assert.notEqual(mv.MOBILE_STATUS, 'unconfirmed');
  assert.notEqual(mv.MOBILE_STATUS, 'confirmed');
});
