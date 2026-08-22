#!/usr/bin/env node
/**
 * Asserts that the COMMITTED www/secrets.js is still the empty placeholder.
 *
 * CI overwrites that file with real values at build time
 * (scripts/inject-secrets.js). If someone runs that locally with their
 * environment populated and then commits the result, the credentials go
 * straight back into a public repo — which is exactly the failure this whole
 * arrangement exists to prevent. This is the guard for that specific mistake.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'www', 'secrets.js');
const src = fs.readFileSync(file, 'utf8');

// Parse rather than execute: the file is a plain object literal assignment,
// and this script must never run untrusted code from the tree it is checking.
const match = src.match(/window\.APP_SECRETS\s*=\s*(\{[\s\S]*?\})\s*;/);
if (!match) {
  console.error('FAILED: www/secrets.js does not assign a plain object to window.APP_SECRETS.');
  process.exit(1);
}
const json = match[1]
  .replace(/\/\/[^\n]*/g, '')                       // line comments
  .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')  // bare keys -> quoted
  .replace(/'/g, '"')                                // single -> double quotes
  .replace(/,(\s*})/g, '$1');                        // trailing commas

let cfg;
try { cfg = JSON.parse(json); }
catch (e) { console.error('FAILED: could not parse www/secrets.js — keep it a simple object literal. ' + e.message); process.exit(1); }

const filled = Object.keys(cfg).filter((k) => cfg[k]);
if (filled.length) {
  console.error('FAILED: www/secrets.js is committed with real values for: ' + filled.join(', '));
  console.error('That file must stay EMPTY in git — CI fills it at build time from GitHub secrets.');
  console.error('Revert it (git checkout -- www/secrets.js) and ROTATE anything that was committed.');
  process.exit(1);
}
console.log('OK: committed www/secrets.js is the empty placeholder, as required.');
