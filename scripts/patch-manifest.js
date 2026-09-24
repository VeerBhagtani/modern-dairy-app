#!/usr/bin/env node
/* Patch the generated Modern Drivers Android manifest.
 *
 * `npx cap add android` produces a manifest with only INTERNET. A foreground
 * location service needs four more permissions, and Android 14 additionally
 * requires the service to declare foregroundServiceType="location" — without
 * it the app crashes the moment tracking starts, on exactly the newest phones.
 *
 * This runs after `cap add android` (locally and in CI) so the native project
 * stays generated rather than committed, while still being correct.
 *
 * Idempotent: running it twice changes nothing.
 */
const fs = require('fs');
const path = require('path');

const manifestPath = process.argv[2]
  || path.join(__dirname, '..', 'app', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.error(`No manifest at ${manifestPath}. Run "npx cap add android" in driver-app/ first.`);
  process.exit(1);
}

let xml = fs.readFileSync(manifestPath, 'utf8');
const before = xml;

const PERMISSIONS = [
  // Precise location while the app is in use.
  'android.permission.ACCESS_FINE_LOCATION',
  // Coarse location — requested alongside fine, because Android 12+ lets the
  // user grant only this one and the app must keep working (less accurately)
  // rather than appearing broken.
  'android.permission.ACCESS_COARSE_LOCATION',
  // Location while the app is in the background. This is the permission Google
  // Play scrutinises; see docs/modern-drivers/PLAY_BACKGROUND_LOCATION.md.
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  // Run the tracking service in the foreground with a persistent notification.
  'android.permission.FOREGROUND_SERVICE',
  // Android 14 split the above by type.
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  // Re-register the service after a reboot (best effort; see the app README on
  // what Android actually guarantees here).
  'android.permission.RECEIVE_BOOT_COMPLETED',
  // Report whether the phone is online, for the tracking-health panel.
  'android.permission.ACCESS_NETWORK_STATE',
  // The driver app posts no notifications of its own, but Android 13+ requires
  // this for the foreground-service notification to be visible.
  'android.permission.POST_NOTIFICATIONS',
  // Lets the app show Android's "always run in background?" dialog, the one
  // setting that keeps phone makers' battery savers from closing a ride in
  // progress. See app/native/android/BatteryOptimisationPlugin.java. (Play
  // Store restricts this permission; the app is installed from an APK.)
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
];

for (const perm of PERMISSIONS) {
  if (xml.includes(`android:name="${perm}"`)) continue;
  xml = xml.replace(
    /<\/manifest>/,
    `    <uses-permission android:name="${perm}" />\n</manifest>`,
  );
}

// Android 14 requires a location foreground service to declare its type, and
// the plugin's own manifest may predate that requirement.
//
// The plugin ALREADY declares this service, so a second full declaration here
// is a manifest-merger conflict, not an addition — the first version of this
// script declared android:exported="false" against the plugin's "true" and the
// build failed outright. So: merge into the existing declaration
// (tools:node="merge"), set only the one attribute we care about, and say
// explicitly that ours wins (tools:replace). Every other attribute — exported
// included — is left to the plugin.
if (!xml.includes('BackgroundGeolocationService')) {
  // tools: attributes need the namespace on the root element; a generated
  // Capacitor manifest usually has it, but do not rely on that.
  if (!xml.includes('xmlns:tools=')) {
    xml = xml.replace(
      /<manifest([^>]*)>/,
      '<manifest$1\n    xmlns:tools="http://schemas.android.com/tools">',
    );
  }
  xml = xml.replace(
    /<\/application>/,
    '        <service\n'
    + '            android:name="com.equimaps.capacitor_background_geolocation.BackgroundGeolocationService"\n'
    + '            android:foregroundServiceType="location"\n'
    + '            tools:node="merge"\n'
    + '            tools:replace="android:foregroundServiceType" />\n'
    + '    </application>',
  );
}

if (xml === before) {
  console.log('AndroidManifest.xml already patched — nothing to do.');
} else {
  fs.writeFileSync(manifestPath, xml);
  console.log(`Patched ${manifestPath}: location permissions and the foreground service type are in place.`);
}
