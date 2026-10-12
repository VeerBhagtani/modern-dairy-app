// The phone's own ride recorder (app/native/android/TrackingService.java).
// It cannot run here; these check, in the source, the properties the trial
// showed are essential. The Java is compiled in CI (release.yml).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SVC = read('app/native/android/TrackingService.java');
const STORE = read('app/native/android/TrackingStore.java');
const PLUGIN = read('app/native/android/NativeTrackingPlugin.java');

test('a started service, not bound to the app\'s screen, restarted by Android if killed', () => {
  assert.match(SVC, /public IBinder onBind\(Intent intent\) \{\s*return null;/, 'not a bound service');
  assert.match(SVC, /return START_STICKY;/);
  // A killed-and-restarted service (null intent) carries on with the saved ride.
  assert.match(SVC, /else if \(prefs\.getBoolean\("active", false\)\) \{[\s\S]{0,300}startRecording\(\);/);
  assert.doesNotMatch(PLUGIN, /handleOnDestroy\(\) \{[^}]*stop/, 'the screen going away never stops the recorder');
  const removed = SVC.slice(SVC.indexOf('public void onTaskRemoved'), SVC.indexOf('public void onDestroy'));
  assert.doesNotMatch(removed, /stopSelf|stopRecording/, 'swiping the app away does not end the ride');
});

test('a foreground service of type location, with its notification', () => {
  assert.match(SVC, /startForeground\(NOTIFICATION_ID, n, ServiceInfo\.FOREGROUND_SERVICE_TYPE_LOCATION\)/);
  const m = read('scripts/patch-manifest.js');
  assert.match(m, /android:name="\.TrackingService" android:exported="false" android:foregroundServiceType="location"/);
  assert.match(m, /android\.permission\.WAKE_LOCK/);
  assert.match(read('scripts/add-native.js'), /'NativeTrackingPlugin'/);
});

test('every fix is saved before it is sent, and marked sent only on the server\'s word', () => {
  const loc = SVC.slice(SVC.indexOf('public void onLocationChanged'), SVC.indexOf('public void onStatusChanged'));
  assert.match(loc, /store\.add\(f\);/);
  assert.doesNotMatch(loc, /call\(|send\(/, 'no network on the GPS path');
  const up = SVC.slice(SVC.indexOf('private void upload()'), SVC.indexOf('private void rideEnded()'));
  assert.match(up, /if \(r\.ok\) \{[\s\S]*optJSONArray\("accepted"\)[\s\S]*optJSONArray\("rejected"\)[\s\S]*store\.markSent\(done\);/);
  assert.match(up, /"RIDE_NOT_FOUND"\.equals\(r\.code\) \|\| "NOT_YOUR_RIDE"\.equals\(r\.code\)/, 'dropped only on these two answers');
  assert.match(up, /failed\(r\);\s*return;/, 'anything else keeps the fixes and backs off');
  assert.match(STORE, /WHERE sent = 0 ORDER BY ts, id LIMIT/);
  assert.match(STORE, /DELETE FROM fixes WHERE sent = 1 AND ts < \?/, 'only sent rows are ever purged');
});

test('a ride started offline is registered first, under the phone\'s id and start time', () => {
  const up = SVC.slice(SVC.indexOf('private void upload()'), SVC.indexOf('private void rideEnded()'));
  assert.match(up, /!prefs\.getBoolean\("rideRegistered", true\)[\s\S]*call\("POST", "\/driver\/rides\/start", body\)/);
  assert.match(up, /body\.put\("rideId", ride\);\s*body\.put\("startedAt"/);
  assert.match(up, /if \(current && !prefs\.getBoolean\("rideRegistered", true\)\) continue;/, 'no fixes before the ride exists');
  assert.match(up, /serverRideId/, 'fixes follow the server\'s ride id if it answered with another');
});

test('uploads carry the phone clock and state, back off with jitter, and sign in again by themselves', () => {
  assert.match(SVC, /body\.put\("sentAt", System\.currentTimeMillis\(\)\);/);
  assert.match(SVC, /body\.put\("health", health\(\)\);/);
  assert.match(SVC, /long base = Math\.min\(300000L, 5000L \* \(1L << Math\.min\(n - 1, 10\)\)\);/);
  assert.match(SVC, /\(0\.5 \+ Math\.random\(\)\)/);
  assert.match(SVC, /if \(r\.status == 401 && refresh\(\)\)/);
  assert.match(SVC, /h\.put\("recorder", "native"\);/);
  // The heartbeat is how a phone with no GPS fixes still hears the office stop the ride.
  assert.match(SVC, /call\("POST", "\/driver\/health", body\)[\s\S]*activeRideId[\s\S]*rideEnded\(\)/);
});

test('overnight rides: GPS slows to every 20 s when parked 10 min, full rate the moment it moves', () => {
  assert.match(SVC, /GPS_MOVING_MS = 2000L/);
  assert.match(SVC, /GPS_PARKED_MS = 20000L/);
  assert.match(SVC, /PARK_AFTER_MS = 10 \* 60 \* 1000L/);
  const adapt = SVC.slice(SVC.indexOf('private void adaptRate'), SVC.indexOf('private void setRate'));
  assert.match(adapt, /d\[0\] > PARK_RADIUS_M[\s\S]*setRate\(GPS_MOVING_MS\)/, 'moving away: back to full rate');
  assert.match(adapt, /now - anchorAt > PARK_AFTER_MS\)[\s\S]*setRate\(GPS_PARKED_MS\)/);
});

test('the phone says which phone it is', () => {
  assert.match(SVC, /h\.put\("phone", \(Build\.MANUFACTURER \+ " " \+ Build\.MODEL\)\.trim\(\)\);/);
  assert.match(SVC, /h\.put\("android", /);
});
