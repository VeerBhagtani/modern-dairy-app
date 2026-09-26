// Customers delivered by Modern Dairy's own truck, not by drivers: marked
// from the Locations tab and kept out of everything Modern Drivers does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const views = read('dashboard/views.js');
const { stopEligibility, INELIGIBLE } = require('./src/drivers/eligibility');
const { isTruckRoute, TRUCK_ROUTE_STATUS } = require('./src/drivers/truckRoute');
const { needsAudit } = require('./src/services/locationAudit');

test('a truck-delivery customer is never a stop and never audited', () => {
  const p = { id: 'x', name: 'Hotel Far', truckRoute: true, locationStatus: TRUCK_ROUTE_STATUS };
  assert.equal(isTruckRoute(p), true);
  const e = stopEligibility(p);
  assert.equal(e.ok, false);
  assert.equal(e.reason, INELIGIBLE.TRUCK_ROUTE);
  assert.match(e.message, /Modern Dairy truck/);
  // Even with a pin it somehow kept, it is not a stop.
  assert.equal(stopEligibility({ ...p, lat: 18.5, lng: 73.8 }).ok, false);
  assert.equal(needsAudit({ ...p, lat: 18.5, lng: 73.8 }), false);
  assert.equal(isTruckRoute({ name: 'y', lat: 1, lng: 1 }), false);
});

test('its own status keeps it out of the lookup, the place-by-hand list and the geofences', () => {
  assert.notEqual(TRUCK_ROUTE_STATUS, 'pending');
  assert.notEqual(TRUCK_ROUTE_STATUS, 'unconfirmed');
  const repo = read('backend/src/services/repo.js');
  assert.match(repo, /p\.truckRoute !== true && p\.locationStatus !== 'truck_route'/);
  const admin = read('backend/src/routes/admin.js');
  const route = admin.slice(admin.indexOf("router.post('/restaurants/:id/truck-route'"), admin.indexOf("// POST /admin/restaurants/:id/hold"));
  assert.match(route, /requireRole\('manager'\), writeLimiter/);
  assert.match(route, /pinRemoval\(before/, 'any pin is kept in its history, not thrown away');
  assert.match(route, /action: on \? 'restaurants\.mark_truck_route' : 'restaurants\.unmark_truck_route'/, 'audited');
  assert.match(route, /repo\.invalidatePlaceCache\(\)/);
});

test('the dashboard offers it on every row with no location, in bulk and in the map dialog', () => {
  const btn = views.slice(views.indexOf('function truckButton(p)'), views.indexOf('var truckBound'));
  assert.match(btn, /if \(hasPin\(p\) \|\| isMobilePlace\(p\)\) return '';/);
  assert.match(btn, />Truck delivery</);
  assert.match(btn, />Back to drivers</);
  const need = views.slice(views.indexOf('function needsYouCard('), views.indexOf('function pickOnMap('));
  assert.match(need, /truckButton\(p\)/);
  assert.match(need, /id="btnTruckTicked"/);
  assert.match(views.slice(views.indexOf('function placeQueue('), views.indexOf('function bindGeocodingKey(')), /API\.setTruckRoute\(p\.id, true\)/);
  assert.match(views, /\['truck', 'Truck delivery'\]/, 'a Restaurants filter to find them again');
  assert.match(views, /if \(restFilter\.show === 'nopin'\) return !hasPin\(p\) && !noPinNeeded\(p\);/);
  assert.match(views, /if \(turningOn && !confirm\(truckConfirm\(name\)\)\) return;/);
  assert.match(read('dashboard/api.js'), /\/truck-route'/);
});
