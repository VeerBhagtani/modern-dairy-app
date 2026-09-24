// The driver app's origin must be allowed to call the API.
//
// This exists because of a real outage, not a hypothetical one. The deploy
// configured CORS for the office dashboard only, on the stated assumption that
// "the Android app sends no Origin". It is a WebView, not a native HTTP client,
// so it sends one like any browser — and every phone in the fleet was refused
// by its own browser before the request left the device. The driver saw
// "Failed to fetch" and nothing else; the server logged nothing, because the
// request never arrived.
//
// The check is static, like security.test.mjs, because the failure is in the
// deploy configuration rather than in any running code — there is nothing to
// import that would catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploy = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const capacitor = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/capacitor.config.json'), 'utf8'));

// The one line in the deploy that decides which origins may call the API.
const originsLine = deploy.split('\n').find((l) => l.trim().startsWith('ORIGINS='));

test('the deploy sets an allowlist at all', () => {
  assert.ok(originsLine, 'ORIGINS= is not set in the deploy workflow');
});

test("the driver app's own WebView origin is allowed", () => {
  // Capacitor's androidScheme decides this. With "https" the WebView origin is
  // https://localhost; if somebody changes the scheme, this test should be the
  // thing that notices, so it reads the scheme rather than assuming it.
  const scheme = (capacitor.server && capacitor.server.androidScheme) || 'http';
  const expected = `${scheme}://localhost`;
  assert.ok(
    originsLine.includes(expected),
    `androidScheme is "${scheme}", so the app's origin is ${expected}, which must be in ALLOWED_ORIGINS. `
    + 'Without it every driver gets "Failed to fetch" and no ride can start.',
  );
});

test('the office dashboard is still allowed', () => {
  assert.match(originsLine, /github\.io/, 'the dashboard is served from GitHub Pages');
});

test('the allowlist is a list of origins, not URLs with paths', () => {
  // An entry with a path or a trailing slash never matches: the browser sends a
  // bare scheme://host[:port], and a mismatch here fails silently at runtime.
  const value = originsLine.slice(originsLine.indexOf('=') + 1).replace(/^["']|["']$/g, '');
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (!entry || entry.includes('${')) continue;   // shell-interpolated, checked above
    assert.ok(!entry.endsWith('/'), `"${entry}" has a trailing slash and will never match`);
    assert.ok(
      !/^[a-z]+:\/\/[^/]+\//.test(entry),
      `"${entry}" has a path; an Origin header never carries one`,
    );
  }
});

test('the code no longer claims the app sends no Origin', () => {
  // The wrong comment is what made the wrong configuration look correct, so it
  // is worth keeping it from coming back.
  const index = fs.readFileSync(path.join(ROOT, 'backend/src/index.js'), 'utf8');
  const claim = /no Origin \(the Android app/;
  assert.ok(!claim.test(index), 'that assumption is false and caused an outage — see the CORS block');
});
