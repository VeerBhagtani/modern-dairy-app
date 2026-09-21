#!/usr/bin/env node
/* Write the backend URL into driver-app/www/config.js at build time.
 *
 * The committed config.js has an empty API_BASE, and an app with no API_BASE
 * refuses to start a ride. The real URL is environment-specific (staging vs
 * production) and comes from the DRIVERS_API_BASE repository secret, so one
 * source tree produces both APKs.
 *
 * https is required: location data must never cross the network in the clear.
 *
 * Usage: node scripts/set-drivers-api-base.js <https://...> [config.js path]
 */
const fs = require('fs');
const path = require('path');

const base = String(process.argv[2] || process.env.API_BASE || '').trim().replace(/\/+$/, '');
const target = process.argv[3] || path.join(__dirname, '..', 'app', 'www', 'config.js');

if (!base) {
  console.error('No API base URL given. Set DRIVERS_API_BASE or pass it as the first argument.');
  process.exit(1);
}
if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/.test(base)) {
  console.error(`"${base}" is not a valid https:// URL.`);
  process.exit(1);
}
if (!fs.existsSync(target)) {
  console.error(`No config file at ${target}`);
  process.exit(1);
}

const src = fs.readFileSync(target, 'utf8');
const LINE = /API_BASE:\s*'[^']*'/;

// Absence of the line is the failure. An unchanged file is not: the second
// deploy to the same address produces identical text, and treating that as an
// error made a re-run fail on a step that had nothing left to do.
if (!LINE.test(src)) {
  console.error('Could not find the API_BASE line to replace — has config.js been reformatted?');
  process.exit(1);
}

const out = src.replace(LINE, `API_BASE: '${base}'`);
if (out === src) {
  console.log(`${path.relative(process.cwd(), target)} already points at ${base}`);
  process.exit(0);
}
fs.writeFileSync(target, out);
console.log(`${path.relative(process.cwd(), target)} now points at ${base}`);
