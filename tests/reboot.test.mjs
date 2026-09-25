// A phone restart mid-ride: Android forbids restarting location tracking from
// the background, so the app leaves a "tap to continue" notification instead.
// The device behaviour itself needs a real phone (docs/DEVICE_TESTS.md); this
// checks every piece that can be checked without one.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the manifest declares the restart receiver, not exported, idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-manifest-'));
  const m = path.join(dir, 'AndroidManifest.xml');
  fs.writeFileSync(m, '<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n<application>\n</application>\n</manifest>\n');
  execFileSync('node', [path.join(ROOT, 'scripts/patch-manifest.js'), m]);
  const once = fs.readFileSync(m, 'utf8');
  execFileSync('node', [path.join(ROOT, 'scripts/patch-manifest.js'), m]);
  assert.equal(fs.readFileSync(m, 'utf8'), once, 'a second run changes nothing');
  assert.match(once, /<receiver android:name="\.BootReceiver" android:exported="false">/);
  for (const a of ['BOOT_COMPLETED', 'MY_PACKAGE_REPLACED']) assert.match(once, new RegExp(`android.intent.action.${a}`));
  assert.match(once, /RECEIVE_BOOT_COMPLETED/);
});

test('the receiver only notifies when a ride was being recorded, and never starts tracking itself', () => {
  const src = read('app/native/android/BootReceiver.java');
  assert.match(src, /if \(!prefs\.getBoolean\(KEY_ACTIVE, false\)\) return;/);
  assert.doesNotMatch(src, /startForegroundService|startService\(/, 'Android 10+ forbids it; a crash loop would be worse');
  assert.match(src, /PendingIntent\.FLAG_IMMUTABLE/, 'required from Android 12');
  assert.match(src, /Build\.VERSION\.SDK_INT >= 26/, 'channels only where they exist');
  const plugin = read('app/native/android/BatteryOptimisationPlugin.java');
  assert.match(plugin, /public void setRideActive\(PluginCall call\)/);
  assert.match(read('scripts/add-native.js'), /const OTHERS = \['BootReceiver'\];/);
});

test('the app keeps the native flag in step with recording', () => {
  const app = read('app/www/app.js');
  const add = app.slice(app.indexOf('function addRecorder()'), app.indexOf('function watcherFailed('));
  assert.match(add, /state\.watcherId = id;[\s\S]*markRideNative\(true\);/);
  const stop = app.slice(app.indexOf('function stopWatcher()'), app.indexOf('// ── sync'));
  assert.match(stop, /if \(!riding\(\)\) markRideNative\(false\);/);
  // Opening the app after the notification resumes by itself.
  const resume = app.slice(app.indexOf('function resume()'), app.indexOf('function resume()') + 600);
  assert.match(resume, /checkRide\(\)/);
});
