// Planning a round: a name is required, and the round is drawn on the map
// with turn-by-turn navigation through Google Maps.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const app = read('app/www/app.js');
const html = read('app/www/index.html');

test('a round cannot be planned without a name, on the phone or on the server', () => {
  const drv = read('backend/src/routes/driver.js');
  const plan = drv.slice(drv.indexOf("router.post('/plan'"));
  assert.match(plan, /if \(!named\.name\) return res\.status\(400\)[\s\S]{0,60}NAME_REQUIRED/);
  assert.match(app, /if \(go\) go\.disabled = n < 2 \|\| !named;/);
  assert.doesNotMatch(app, /NAME THIS ROUND <span[^>]*>\(optional\)/);
});

test('the plan carries coordinates, and the app draws numbered stops and a line', () => {
  assert.match(read('backend/src/services/tripPlanner.js'), /return \{ id, name: name\(id\), lat: s\.lat \?\? null, lng: s\.lng \?\? null \};/);
  assert.match(app, /function drawPlan\(\)/);
  assert.match(app, /new maplibregl\.Marker\(\{ element: stopEl\(i \+ 1, s\.done\) \}\)/);
  assert.match(app, /new google\.maps\.Marker\(\{ map: gmap\.map, position: \{ lat: s\.lat, lng: s\.lng \}/);
  assert.match(app, /setTimeout\(fitPlan, 350\)/, 'the whole round is brought into view');
});

test('Navigate opens Google Maps directions through the stops left, in order', () => {
  const fn = app.slice(app.indexOf('function navUrl(stops)'), app.indexOf('function nextStop()'));
  assert.match(fn, /https:\/\/www\.google\.com\/maps\/dir\/\?api=1&travelmode=driving&dir_action=navigate&destination=/);
  assert.match(fn, /&waypoints=' \+ encodeURIComponent\(via\)/);
  assert.match(app, /'<a class="navall" href="' \+ esc\(navUrl\(todo\)\) \+ '">Navigate the round in Google Maps<\/a>'/);
  assert.match(app, /Navigate here<\/a>/);
});

test('a bigger map with a full-screen mode, and "stops done" instead of GPS points', () => {
  assert.match(html, /#mapWrap\{position:relative;flex:none;height:48vh;min-height:280px;\}/);
  assert.match(html, /\.screen\.bigmap #mapWrap\{position:fixed;inset:0;/);
  assert.match(html, /id="btnBigMap"/);
  assert.match(html, /<b id="stStops">—<\/b><span>stops done<\/span>/);
  assert.doesNotMatch(html, /<span>points<\/span>/);
  assert.match(app, /haversine\(\{ lat: loc\.latitude, lng: loc\.longitude \}, s\) <= 120/, 'a stop counts as reached within 120 m');
  assert.match(app, /if \(state\.plan && state\.plan\.day !== todayKey\(\)\) \{ state\.plan = null; LS\.del\('plan'\); \}/, 'kept for today only');
});
