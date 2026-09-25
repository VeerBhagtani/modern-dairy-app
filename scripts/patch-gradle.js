#!/usr/bin/env node
/* Release signing and version numbers for the generated Android project.
 *
 * Every APK used to be a debug build signed by the throwaway debug key a fresh
 * CI machine makes for itself — a different key every build. Android refuses
 * to install an update signed by a different key, so each new APK meant
 * uninstalling the old one first, and uninstalling deletes the GPS points
 * still waiting on the phone to be sent, and the driver's sign-in.
 *
 * This makes the release build sign with ONE permanent key (kept in the
 * project's Secret Manager, handed to the build in MD_KEYSTORE,
 * MD_KEYSTORE_PASSWORD, MD_KEY_ALIAS), and gives every build a higher
 * versionCode (APP_VERSION_CODE) so Android treats it as an update.
 *
 * Without the keystore variables the release build is left unsigned, and the
 * workflow refuses to publish it — an unsigned APK cannot be installed.
 *
 * Usage: node scripts/patch-gradle.js [path/to/app/android/app/build.gradle]
 * Idempotent.
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'app', 'android', 'app', 'build.gradle');
let s = fs.readFileSync(file, 'utf8');
if (s.includes('MD_KEYSTORE')) { console.log(`${file} already patched.`); process.exit(0); }

const must = (re, what) => { if (!re.test(s)) { console.error(`patch-gradle: could not find ${what} in ${file}`); process.exit(1); } };
must(/versionCode 1\b/, 'versionCode 1');
must(/versionName "1\.0"/, 'versionName "1.0"');
must(/buildTypes \{\s*release \{/, 'buildTypes { release {');

s = s.replace(/versionCode 1\b/, "versionCode Integer.parseInt(System.getenv('APP_VERSION_CODE') ?: '1')");
s = s.replace(/versionName "1\.0"/, "versionName (System.getenv('APP_VERSION_NAME') ?: '1.0')");
s = s.replace(/buildTypes \{\s*release \{/, `signingConfigs {
        release {
            if (System.getenv('MD_KEYSTORE')) {
                storeFile file(System.getenv('MD_KEYSTORE'))
                storePassword System.getenv('MD_KEYSTORE_PASSWORD')
                keyAlias System.getenv('MD_KEY_ALIAS') ?: 'moderndrivers'
                keyPassword System.getenv('MD_KEYSTORE_PASSWORD')
            }
        }
    }
    buildTypes {
        release {
            if (System.getenv('MD_KEYSTORE')) signingConfig signingConfigs.release`);
fs.writeFileSync(file, s);
console.log(`Patched ${file}: release signing from MD_KEYSTORE, versionCode from APP_VERSION_CODE.`);
