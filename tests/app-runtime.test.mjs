// The driver app must ship Capacitor's JavaScript runtime.
//
// It did not, from the first APK. Android's WebView injects only Capacitor's
// low-level bridge — window.Capacitor with nativeCallback and nativePromise.
// registerPlugin, which every plugin call in app.js goes through, is defined in
// @capacitor/core's browser bundle, and an app with no bundler has to load that
// itself. Nothing loaded it. So every phone saw window.Capacitor with no
// registerPlugin, the app could never reach GPS, and it told drivers standing
// in the app that they were "not running inside the app".
//
// The location tests missed it because their fake Capacitor supplied
// registerPlugin — which is what the real bridge never does. These tests check
// the build instead: that the file is loaded, from the right place, in the
// right order, and copied in before Android packages the web assets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the app page loads capacitor.js before app.js', () => {
  const html = read('app/www/index.html');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const runtime = scripts.indexOf('capacitor.js');
  const app = scripts.indexOf('app.js');
  assert.notEqual(runtime, -1, 'index.html must load capacitor.js');
  assert.ok(runtime < app, 'capacitor.js must load before app.js, which uses registerPlugin as it starts');
});

test('the release build copies the runtime in before Android packages the web assets', () => {
  const yml = read('.github/workflows/release.yml');
  const copy = yml.indexOf('node_modules/@capacitor/core/dist/capacitor.js www/capacitor.js');
  assert.notEqual(copy, -1, 'release.yml must copy capacitor.js into www/');
  // Everything cap add / cap sync copies into the APK is taken from www/ at
  // that moment, so a copy after them would build an APK without the file.
  assert.ok(copy < yml.indexOf('npx cap add android'), 'copied before cap add');
  assert.ok(copy < yml.indexOf('npx cap sync android'), 'copied before cap sync');
});

test('a local APK build copies the runtime too', () => {
  const pkg = JSON.parse(read('package.json'));
  const apk = pkg.scripts.apk;
  assert.ok(apk.includes('@capacitor/core/dist/capacitor.js'), 'npm run apk must copy capacitor.js');
  assert.ok(apk.indexOf('capacitor.js') < apk.indexOf('cap add'), 'before cap add');
});

test('the copied file is not committed, so it cannot drift from the native version', () => {
  assert.match(read('.gitignore'), /^app\/www\/capacitor\.js$/m);
});

test('the app tells "opened in a browser" apart from "APK missing its runtime"', () => {
  // The bug's worst symptom was the message: it blamed the driver for opening
  // a browser tab when the fault was in the APK.
  const src = read('app/www/app.js');
  const fn = src.slice(src.indexOf('function locationTrouble'), src.indexOf('var lastKept'));
  assert.match(fn, /if \(!window\.Capacitor\) \{[\s\S]*?browser tab/, 'no bridge at all → browser');
  assert.match(fn, /if \(!window\.Capacitor\.registerPlugin\) \{[\s\S]*?new APK/, 'bridge without runtime → new APK');
});
