// Restaurants with no location can be marked as food trucks from the
// Locations tab: per row, several at once, and from the place-by-hand map.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = fs.readFileSync(path.join(ROOT, 'dashboard/views.js'), 'utf8');

test('only unpinned restaurants get "Food truck"; marked ones can be moved back', () => {
  const fn = views.slice(views.indexOf('function truckButton(p)'), views.indexOf('var truckBound'));
  assert.match(fn, /if \(isMobilePlace\(p\)\)[\s\S]*Not a food truck/);
  assert.match(fn, /if \(hasPin\(p\)\) return '';/, 'a pinned one is marked from its own page, where the lost pin is shown');
});

test('the need-you list, the all-restaurants table and the map dialog all offer it', () => {
  const need = views.slice(views.indexOf('function needsYouCard('), views.indexOf('function pickOnMap('));
  assert.match(need, /truckButton\(p\)/);
  assert.match(need, /id="btnTruckTicked"/);
  assert.match(need, /class="truck-tick"/);
  const table = views.slice(views.indexOf('function fillPlaceTable('), views.indexOf('function bindHoldButtons('));
  assert.match(table, /kind === 'restaurants' \? truckButton\(p\) : ''/);
  const dialog = views.slice(views.indexOf('function placeQueue('), views.indexOf('function bindGeocodingKey('));
  assert.match(dialog, /id="pickTruck"/);
  assert.match(dialog, /API\.setMobile\(p\.id, true\)/);
  assert.match(views, /bindTruckButtons\(\);/);
  // Every mark asks first, and goes through the audited server route.
  assert.match(views, /if \(turningOn && !confirm\(truckConfirm\(name\)\)\) return;/);
});
