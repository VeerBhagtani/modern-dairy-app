#!/usr/bin/env node
/**
 * Writes www/secrets.js from environment variables at BUILD time.
 *
 * Why this exists: the Message Central OTP credential and the sandbox.co.in
 * GST key + secret used to be hardcoded string literals inside
 * www/index.html — a file committed to a PUBLIC GitHub repository. Anyone
 * could read them straight off github.com and spend real money against both
 * accounts. They now live only in GitHub Actions secrets and are written
 * here, immediately before `npx cap sync` copies www/ into the app bundle.
 * The copy of www/secrets.js committed to the repo stays empty.
 *
 * This does NOT make them server-side. Whatever is written here ships inside
 * the APK and can be recovered by anyone who decompiles it. The permanent fix
 * is backend/src/services/{messageCentralClient,gstClient}.js once Cloud Run is
 * deployed. This step removes the public-internet exposure, nothing more.
 *
 * With no secrets set the build still succeeds and produces a DEMO-mode app
 * (test number / test GSTIN only, no real provider calls) — deliberately, so
 * a misconfigured CI run can never ship a half-live build.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KEYS = ['OTP_CUSTOMER_ID', 'OTP_AUTH_TOKEN', 'GST_API_KEY', 'GST_API_SECRET'];

const cfg = {};
for (const k of KEYS) cfg[k] = process.env[k] || '';

/* DEMO_BUILD is NOT a secret — it is the explicit opt-in for the
   every-number-accepts-0000 test path in www/index.html.
   It defaults to OFF and must be asked for by name. The bypass used to be
   derived from `!OTP_HAS_CREDENTIAL`, so a build that simply failed to receive
   its secrets turned the bypass ON. That is the wrong direction: a missing
   input must narrow what a build can do, never widen it. A release build that
   does not set this gets no bypass, and if its credentials are also missing it
   fails loudly at sign-in instead of quietly accepting 0000. */
cfg.DEMO_BUILD = process.env.DEMO_BUILD === 'true' ? 'true' : '';
if (cfg.DEMO_BUILD === 'true' && KEYS.some((k) => cfg[k])) {
  console.error('REFUSING TO BUILD: DEMO_BUILD=true was set alongside real provider credentials.');
  console.error('That combination would ship the OTP test bypass in a build that can send real SMS.');
  process.exit(1);
}

const out = [
  '/* GENERATED AT BUILD TIME from CI secrets by scripts/inject-secrets.js.',
  '   Never commit real values here — see the header of that script. */',
  'window.APP_SECRETS = ' + JSON.stringify(cfg, null, 2) + ';',
  '',
].join('\n');

const target = path.join(__dirname, '..', 'www', 'secrets.js');
fs.writeFileSync(target, out, 'utf8');

const missing = KEYS.filter((k) => !cfg[k]);
if (!missing.length) {
  console.log('All build-time secrets injected into www/secrets.js.');
} else if (cfg.DEMO_BUILD === 'true') {
  console.log('Building in DEMO mode (DEMO_BUILD=true) — unset: ' + missing.join(', '));
} else {
  // Not a demo build and not fully configured: the app will start, but any
  // feature backed by a missing secret will refuse to run rather than fall
  // back to a test path. Loud, not silent — see OTP_TESTING_MODE.
  console.log('WARNING: these secrets are unset and DEMO_BUILD is off, so the '
    + 'features behind them will be DISABLED (not stubbed): ' + missing.join(', '));
}
// Never print the values themselves, not even truncated — CI logs are public
// on a public repo.
