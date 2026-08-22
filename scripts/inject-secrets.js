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
 * is backend/src/services/{smsClient,gstClient}.js once Cloud Run is
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

const out = [
  '/* GENERATED AT BUILD TIME from CI secrets by scripts/inject-secrets.js.',
  '   Never commit real values here — see the header of that script. */',
  'window.APP_SECRETS = ' + JSON.stringify(cfg, null, 2) + ';',
  '',
].join('\n');

const target = path.join(__dirname, '..', 'www', 'secrets.js');
fs.writeFileSync(target, out, 'utf8');

const missing = KEYS.filter((k) => !cfg[k]);
if (missing.length) {
  console.log('WARNING: building in DEMO mode — these secrets are unset: ' + missing.join(', '));
} else {
  console.log('All build-time secrets injected into www/secrets.js.');
}
// Never print the values themselves, not even truncated — CI logs are public
// on a public repo.
