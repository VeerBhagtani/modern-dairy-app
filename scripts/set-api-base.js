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
const out = src.replace(/API_BASE:\s*'[^']*'/, `API_BASE: '${base}'`);
if (out === src) {
  console.error('Could not find the API_BASE line to replace — has config.js been reformatted?');
  process.exit(1);
}
fs.writeFileSync(target, out);
console.log(`${path.relative(process.cwd(), target)} now points at ${base}`);
