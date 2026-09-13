#!/usr/bin/env node
/**
 * Deployment preflight — the single gate that says whether this tree can be
 * shipped, and refuses to be optimistic about it.
 *
 * Two modes, because two different things can be wrong:
 *
 *   node scripts/preflight.js            (repo mode)
 *     Checks the COMMITTED tree: no credentials in it, the generated files
 *     still at their placeholders, firebase.json pointing at files that
 *     exist, the native config self-consistent, indexes deployable.
 *     Run before a build, and in CI on every push.
 *
 *   node scripts/preflight.js --built    (built mode)
 *     Run AFTER inject-secrets.js + inject-config.js and BEFORE packaging.
 *     Checks the build that is about to ship is coherent: a live build isn't
 *     carrying the OTP test bypass, a demo build isn't carrying live
 *     credentials, and DEMO/API_BASE agree.
 *
 * Failures exit non-zero and stop the build. Warnings are printed and do not:
 * they are the items that need a console we don't have from here (App Check,
 * the admin custom claim, TTL policies) and are tracked in DEPLOYMENT.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILT = process.argv.includes('--built');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let failures = 0, warnings = 0, checks = 0;
const ok = (msg) => { checks++; console.log('  ok    ' + msg); };
const bad = (msg, detail) => {
  checks++; failures++;
  console.log('  FAIL  ' + msg);
  if (detail) console.log('        ' + String(detail).split('\n').join('\n        '));
};
const warn = (msg, detail) => {
  warnings++;
  console.log('  warn  ' + msg);
  if (detail) console.log('        ' + String(detail).split('\n').join('\n        '));
};
const check = (cond, msg, detail) => (cond ? ok(msg) : bad(msg, detail));
const section = (name) => console.log('\n' + name);

/* Parses `window.X = { ... };` without executing it — these files are
   generated, and a check that runs the thing it is checking is not a check.
   The generated form is already strict JSON, so try that first: the lenient
   normaliser below strips // line comments, which would also eat the "//" in
   an https:// value and make a perfectly good built config look corrupt. The
   fallback exists only for the hand-written committed placeholders, which
   carry comments and bare keys. */
function parseAssignedObject(src, varName) {
  const m = src.match(new RegExp('window\\.' + varName + '\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { /* hand-written form — normalise below */ }
  const json = m[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,(\s*})/g, '$1');
  try { return JSON.parse(json); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────
section(BUILT ? 'Build output' : 'Generated files still at their placeholders');

const secretsSrc = read('www/secrets.js');
const configSrc = read('www/config.js');
const secrets = parseAssignedObject(secretsSrc, 'APP_SECRETS');
const config = parseAssignedObject(configSrc, 'APP_CONFIG');
const CREDENTIAL_KEYS = ['OTP_CUSTOMER_ID', 'OTP_AUTH_TOKEN', 'GST_API_KEY', 'GST_API_SECRET'];

check(secrets, 'www/secrets.js parses as a plain object literal');
check(config, 'www/config.js parses as a plain object literal');

if (secrets && config) {
  const filled = CREDENTIAL_KEYS.filter((k) => secrets[k]);
  const demoBuild = secrets.DEMO_BUILD === 'true' || secrets.DEMO_BUILD === true;

  if (!BUILT) {
    // Repo mode: the committed copies must carry nothing. check-no-secrets.js
    // catches credential SHAPES anywhere in the tree; this catches the case
    // where someone ran an injector locally and committed the result.
    check(filled.length === 0,
      'committed www/secrets.js carries no credentials',
      filled.length ? 'filled: ' + filled.join(', ') + ' — revert the file and ROTATE those values.' : '');
    check(!config.API_BASE && config.DEMO === true && !config.RAZORPAY_KEY,
      'committed www/config.js is the DEMO placeholder',
      'got ' + JSON.stringify(config) + ' — set API_BASE/DEMO/RAZORPAY_KEY in the build env instead '
      + '(scripts/inject-config.js), never by editing the committed file.');
  } else {
    // Built mode: the combinations that must never ship together.
    check(!(demoBuild && filled.length),
      'the OTP test bypass is not combined with real credentials',
      'DEMO_BUILD=true alongside ' + filled.join(', ') + ' would ship "every number accepts 0000" '
      + 'in a build that can also send real SMS.');
    check(!(config.DEMO === false && demoBuild),
      'a live build (DEMO=false) does not carry the OTP test bypass');
    check(!(config.DEMO === false && !config.API_BASE),
      'a live build has an API_BASE to call');
    if (config.DEMO === false && filled.length < CREDENTIAL_KEYS.length) {
      warn('live build is missing provider credentials: '
        + CREDENTIAL_KEYS.filter((k) => !secrets[k]).join(', '),
        'Those features will refuse to run (by design — they do not fall back to a test path).');
    }
    if (config.DEMO === true) {
      warn('this build is DEMO mode — it talks to no backend.',
        'Intentional today (Cloud Run is not deployed). Set API_BASE to change it.');
    }
    ok('demo/live flags are internally consistent (DEMO=' + config.DEMO
      + ', DEMO_BUILD=' + !!demoBuild + ', credentials=' + filled.length + '/' + CREDENTIAL_KEYS.length + ')');
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('Firebase deploy targets');

let firebaseJson = null;
try { firebaseJson = JSON.parse(read('firebase.json')); ok('firebase.json parses'); }
catch (e) { bad('firebase.json parses', e.message); }

if (firebaseJson) {
  const targets = [
    ['firestore.rules', firebaseJson.firestore && firebaseJson.firestore.rules],
    ['firestore.indexes', firebaseJson.firestore && firebaseJson.firestore.indexes],
    ['storage.rules', firebaseJson.storage && firebaseJson.storage.rules],
    ['hosting.public', firebaseJson.hosting && firebaseJson.hosting.public],
  ];
  for (const [name, rel] of targets) {
    if (!rel) bad(name + ' is declared in firebase.json', 'missing key — `firebase deploy` would skip it silently.');
    else check(exists(rel), name + ' -> ' + rel + ' exists on disk');
  }

  // Hosting serves legal/ — the admin panel and the rider app live under it.
  // A deploy that silently stopped publishing one of those is the failure
  // that would not be noticed until someone tried to use it.
  for (const page of ['legal/admin/index.html', 'legal/ride/index.html', 'legal/index.html']) {
    check(exists(page), page + ' is present for hosting');
  }
}

// firestore.indexes.json: a composite index that duplicates an automatic
// single-field index is rejected by `firebase deploy` with a 400, after it
// has already deployed the rules. Catch it here instead of half-way through.
let indexes = null;
try { indexes = JSON.parse(read('backend/firestore.indexes.json')); ok('firestore.indexes.json parses'); }
catch (e) { bad('firestore.indexes.json parses', e.message); }

if (indexes) {
  const single = (indexes.indexes || []).filter((i) => (i.fields || []).length < 2);
  check(single.length === 0,
    'no single-field composite indexes (Firestore rejects them — it builds those automatically)',
    single.map((i) => i.collectionGroup + ': ' + JSON.stringify(i.fields)).join('\n'));

  const seen = new Set();
  const dupes = [];
  for (const i of indexes.indexes || []) {
    const key = i.collectionGroup + '|' + (i.queryScope || 'COLLECTION') + '|'
      + (i.fields || []).map((f) => f.fieldPath + ':' + (f.order || f.arrayConfig)).join(',');
    if (seen.has(key)) dupes.push(key); else seen.add(key);
  }
  check(dupes.length === 0, 'no duplicate index definitions', dupes.join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────
section('Firestore rules (the only enforcement layer while the backend is dormant)');

const rules = read('backend/firestore.rules');
check(/rules_version\s*=\s*['"]2['"]/.test(rules), "rules declare rules_version = '2'");

// `allow read: if true` is deliberate on the catalogue collections (products,
// categories, app_config, broadcasts) — they are public data and the audit
// accepted them. An unconditional WRITE never is: it makes the collection
// world-writable by anyone who can reach the project id, which is printed in
// the app bundle. So this looks only for a verb that can mutate.
const openWrites = rules.split('\n')
  .map((l, n) => [n + 1, l])
  .filter(([, l]) => !l.trim().startsWith('//')
    && /allow\s[^;]*\b(write|create|update|delete)\b[^;]*:\s*if\s+true\s*;/.test(l));
check(openWrites.length === 0, 'no unconditional write rule',
  openWrites.map(([n, l]) => 'line ' + n + ': ' + l.trim()).join('\n'));
check(/match\s*\/\{document=\*\*\}\s*\{[\s\S]*?allow read, write:\s*if false;/.test(rules),
  'the catch-all deny for unmatched paths is present');

// Deploy step 8: the hardcoded uid in isAdmin() is a lock-out fallback, not a
// permanent design. It is published in a public repo, so it names a single
// account worth phishing. Warn every single deploy until it is gone.
if (/request\.auth\.uid\s*==\s*'[A-Za-z0-9]{20,}'/.test(rules)) {
  warn('isAdmin() still contains a hardcoded admin uid fallback.',
    'Run backend/scripts/set-admin-claim.js, verify the claim works, then delete the literal '
    + 'and redeploy the rules. See DEPLOYMENT.md step 6.');
}

// ─────────────────────────────────────────────────────────────────────────
section('Native app configuration');

const capacitor = JSON.parse(read('capacitor.config.json'));
const gradle = read('android/app/build.gradle');
const gservices = exists('android/app/google-services.json')
  ? JSON.parse(read('android/app/google-services.json')) : null;

const appIdMatch = gradle.match(/applicationId\s+["']([^"']+)["']/);
check(appIdMatch && appIdMatch[1] === capacitor.appId,
  'gradle applicationId matches capacitor.config.json appId (' + capacitor.appId + ')',
  appIdMatch ? 'gradle has ' + appIdMatch[1] : 'no applicationId found');

check(capacitor.android && capacitor.android.allowMixedContent === false,
  'WebView refuses mixed content');
check(capacitor.android && capacitor.android.webContentsDebuggingEnabled === false,
  'WebView remote debugging is off in shipped builds');
check(capacitor.server && capacitor.server.androidScheme === 'https',
  'androidScheme is https (secure-context APIs and cookies depend on it)');

// google-services.json is how the native layer finds Firebase. A package_name
// mismatch does not fail the build — it fails at runtime, on the device, with
// Firebase simply never initialising.
check(gservices, 'android/app/google-services.json is present');
if (gservices && appIdMatch) {
  const pkgs = (gservices.client || []).map((c) => c.client_info && c.client_info.android_client_info
    && c.client_info.android_client_info.package_name);
  check(pkgs.includes(appIdMatch[1]),
    'google-services.json registers ' + appIdMatch[1],
    'it registers: ' + pkgs.join(', ') + ' — Firebase would never initialise on device.');
}

// versionCode must increase on every Play upload. It was a hardcoded 1, so
// the second upload would have been rejected at the tail end of a release.
const versionCodeLine = (gradle.match(/^\s*versionCode\s+(.+)$/m) || [])[1] || '';
check(/ANDROID_VERSION_CODE/.test(versionCodeLine),
  'versionCode comes from the environment, so consecutive releases can be uploaded',
  'got `versionCode ' + versionCodeLine.trim() + '` — Play rejects a re-upload of a code it has seen, '
  + 'so a literal allows exactly one release.');

// ─────────────────────────────────────────────────────────────────────────
section('Backend (deployed or not, it must be deployable)');

const backendPkg = JSON.parse(read('backend/package.json'));
check(backendPkg.scripts && backendPkg.scripts.start === 'node src/index.js',
  'backend start script is what the container runs');
check(/engines/.test(JSON.stringify(backendPkg)) && backendPkg.engines.node,
  'backend pins a Node engine (' + (backendPkg.engines || {}).node + ')');
check(exists('backend/package-lock.json'),
  'backend/package-lock.json is committed (the Dockerfile runs `npm ci`)');

const dockerfile = read('backend/Dockerfile');
check(/npm ci .*--omit=dev/.test(dockerfile), 'Docker image installs production dependencies only');
check(/--ignore-scripts/.test(dockerfile), 'Docker install runs with --ignore-scripts');
check(/^\s*USER node\s*$/m.test(dockerfile), 'container drops to a non-root user');

const indexJs = read('backend/src/index.js');
check(/process\.env\.PORT/.test(indexJs), 'server binds $PORT (Cloud Run assigns it)');
check(/\/healthz/.test(indexJs), 'server exposes /healthz for the deploy check');
check(/trust proxy/.test(indexJs), "trust proxy is set (rate limiting behind Cloud Run's LB)");

// ─────────────────────────────────────────────────────────────────────────
section('Result');
console.log(`${checks} checks, ${failures} failed, ${warnings} warnings`);
if (failures) {
  console.log('\nNOT DEPLOYABLE — fix the failures above.');
  process.exit(1);
}
console.log(warnings
  ? '\nDeployable. The warnings above need a console we cannot reach from CI — see DEPLOYMENT.md.'
  : '\nDeployable.');
