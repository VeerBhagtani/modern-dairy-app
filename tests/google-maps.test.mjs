// Google Maps everywhere, with the free maps as the fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the browser key is its own secret, served to signed-in users only', () => {
  assert.match(read('backend/src/services/secretManager.js'), /maps_browser: 'maps-browser-key'/);
  const admin = read('backend/src/routes/admin.js');
  assert.match(admin, /router\.get\('\/maps-config', requireRole\('viewer'\)/);
  const driver = read('backend/src/routes/driver.js');
  assert.ok(driver.indexOf("router.get('/maps-config'") > driver.indexOf('router.use(requireDriver())'),
    'the phone must be signed in to get the key');
  assert.match(read('.github/workflows/deploy.yml'), /maps-browser-key/);
});

test('no dashboard screen talks to a map library directly', () => {
  const views = read('dashboard/views.js');
  assert.doesNotMatch(views, /maplibregl|google\.maps/);
  assert.doesNotMatch(views, /MAPS\.fitTo|MAPS\.drawRoute|\.once\('load'|isStyleLoaded/);
  assert.doesNotMatch(views, /\[p\.lng, p\.lat\]/, 'coordinates are {lat,lng}, never arrays');
  assert.match(read('dashboard/api.js'), /mapsConfig: function \(\) \{ return request\(D \+ '\/maps-config'\); \}/);
});

test('Google is used when there is a key, and the free maps otherwise or on refusal', () => {
  const map = read('dashboard/map.js');
  assert.match(map, /maps\.googleapis\.com\/maps\/api\/js\?key=/);
  assert.match(map, /window\.gm_authFailure = function/);
  assert.match(map, /window\.dispatchEvent\(new Event\('md-maps-fallback'\)\)/);
  assert.match(map, /return 'free';/);
  assert.match(read('dashboard/views.js'), /window\.addEventListener\('md-maps-fallback'/);
});

test('map search uses Google Places, falling back to OpenStreetMap', () => {
  const map = read('dashboard/map.js');
  assert.match(map, /P\.searchByText\(/);
  assert.match(map, /return nominatim\(q\);/);
});

test('the office can save the key from Settings, with the restriction steps', () => {
  const views = read('dashboard/views.js');
  assert.match(views, /API\.setIntegrationSecret\('maps_browser', v\)/);
  assert.match(views, /https:\/\/veerbhagtani\.github\.io\/\*/);
  assert.match(views, /https:\/\/localhost\/\*/);
});

test('the driver app loads Google Maps under its CSP, and keeps the free map as fallback', () => {
  const html = read('app/www/index.html');
  const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.match(csp, /script-src [^;]*https:\/\/maps\.googleapis\.com/);
  assert.match(csp, /script-src [^;]*https:\/\/maps\.gstatic\.com/);
  assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
  assert.match(csp, /object-src 'none'/);
  const app = read('app/www/app.js');
  assert.match(app, /apiFetch\('\/driver\/maps-config'\)/);
  assert.match(app, /if \(!google_\) initFreeMap\(\);/);
  assert.match(app, /window\.gm_authFailure = function/);
  assert.doesNotMatch(app, /\n\s+if \(map\) map\.setCenter/, 'centring goes through mapCenter for both maps');
});

test('the page says why a map is not Google Maps, and a refusal is not remembered for ever', () => {
  const map = read('dashboard/map.js');
  for (const code of ['RefererNotAllowedMapError', 'ApiNotActivatedMapError', 'ApiTargetBlockedMapError', 'BillingNotEnabledMapError', 'InvalidKeyMapError']) {
    assert.match(map, new RegExp(code + ':'), code);
  }
  assert.match(map, /Google Maps JavaScript API \(\?:error\|warning\): \(\\w\+\)/);
  assert.match(map, /Date\.now\(\) - r\.at < 2 \* 60 \* 1000/);
  assert.match(map, /state: 'no_key'/);
  const views = read('dashboard/views.js');
  assert.match(views, /Free map, not Google Maps:/);
  assert.match(views, /MAPS\.retry\(\)/);
  assert.match(read('app/www/app.js'), /Date\.now\(\) - \(cached\.refusedAt \|\| 0\) < 30 \* 60 \* 1000/);
});
