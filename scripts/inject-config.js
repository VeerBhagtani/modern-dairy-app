#!/usr/bin/env node
/**
 * Writes www/config.js from environment variables at BUILD time.
 *
 * Companion to inject-secrets.js, and it exists for the same reason: until
 * now the only way to produce a non-demo build was to hand-edit
 * www/config.js — a committed file — flip DEMO to false, build, and remember
 * to revert it. That is a release step that depends on someone's memory, so
 * every release AAB built so far has silently shipped DEMO mode. The target
 * environment is now an input to the build, not a state of the working tree.
 *
 * Nothing written here is a secret. API_BASE is a public URL and RAZORPAY_KEY
 * is Razorpay's publishable key id (the one that is *meant* to be in client
 * code); the Razorpay key SECRET must never come near this file — it lives in
 * Secret Manager and is only ever used by backend/src/routes/payments.js to
 * verify webhook signatures. The shape check below enforces that.
 *
 * With nothing set the build produces a DEMO-mode app, which is what the
 * project is today (the Cloud Run backend is written but not deployed). A
 * misconfigured CI run therefore cannot produce a half-live build: it either
 * has a complete production target or it stays fully offline.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const apiBase = (process.env.API_BASE || '').trim().replace(/\/+$/, '');
const razorpayKey = (process.env.RAZORPAY_KEY || '').trim();

// DEMO defaults from whether a backend was given, so the common case needs no
// second variable. An explicit DEMO=true/false always wins, and is then
// checked for coherence below rather than trusted.
let demo;
if (process.env.DEMO === 'true') demo = true;
else if (process.env.DEMO === 'false') demo = false;
else demo = !apiBase;

const fail = (msg) => { console.error('REFUSING TO BUILD: ' + msg); process.exit(1); };

if (!demo && !apiBase) {
  // CONFIG.DEMO false with an empty API_BASE makes every request fetch a bare
  // path against the capacitor:// origin. That is not a degraded build, it is
  // an app whose every screen errors — and it would ship looking fine.
  fail('DEMO=false was set with no API_BASE. There would be no server to call.');
}
if (apiBase) {
  let url;
  try { url = new URL(apiBase); } catch { url = null; }
  if (!url) fail('API_BASE is not a valid absolute URL: ' + apiBase);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local) {
    // capacitor.config.json sets allowMixedContent:false and androidScheme
    // https, so a cleartext API_BASE is blocked by the WebView at runtime.
    // Better to stop here than to ship an app that cannot reach its server.
    fail('API_BASE must be https (the WebView blocks cleartext): ' + apiBase);
  }
  if (!url.pathname.replace(/\/$/, '').endsWith('/api')) {
    console.log('NOTE: API_BASE does not end in /api — the backend mounts its routes there.');
  }
}
if (razorpayKey && !/^rzp_(live|test)_[A-Za-z0-9]+$/.test(razorpayKey)) {
  // The publishable key id has a fixed shape. Anything else in this slot is
  // most likely the key SECRET, which must never reach a client bundle.
  fail('RAZORPAY_KEY is not a Razorpay key id (expected rzp_live_… or rzp_test_…). '
     + 'The key SECRET must never be put in www/config.js — it belongs in Secret Manager.');
}
if (!demo && razorpayKey.startsWith('rzp_test_')) {
  console.log('WARNING: a production (DEMO=false) build is being given a Razorpay TEST key.');
}

const cfg = { API_BASE: apiBase, DEMO: demo, RAZORPAY_KEY: razorpayKey };

const out = `/* GENERATED AT BUILD TIME by scripts/inject-config.js.
   Do not edit by hand and do not commit real values — the committed copy is
   the DEMO placeholder, and scripts/preflight.js fails the build if it isn't.
   Set API_BASE / DEMO / RAZORPAY_KEY in the build environment instead. */
window.APP_CONFIG = ${JSON.stringify(cfg, null, 2)};
`;

fs.writeFileSync(path.join(__dirname, '..', 'www', 'config.js'), out, 'utf8');
console.log(demo
  ? 'www/config.js written: DEMO mode (no backend).'
  : 'www/config.js written: LIVE against ' + apiBase
    + (razorpayKey ? ' with Razorpay ' + razorpayKey.slice(0, 8) + '…' : ' with no Razorpay key'));
