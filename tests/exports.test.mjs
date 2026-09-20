// Every exported name must actually exist.
//
// This exists because of a real failure, not a hypothetical one. A helper was
// deleted during a refactor and its name was left behind in the file's
// `module.exports`. Node does not notice at parse time — `node --check` passes
// — so the error only appears the instant the module is required, which was
// inside a Cloud Run container, after a six-minute build, as a crash loop with
// no useful message anywhere near the mistake.
//
// The check is static, like the ones in security.test.mjs, because it has to
// run without installing the backend's dependencies: requiring the routes for
// real would pull in Express, Firestore and Secret Manager, and a test suite
// that needs a cloud project to tell you about a typo is not much of a guard.
//
// It reads the shorthand form only — `module.exports = { a, b, c }` — which is
// what the whole backend uses. A renamed export (`{ a: b }`) or a computed one
// is skipped rather than guessed at.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'backend', 'src');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  });
}

// Anything that introduces a binding at module scope, plus imports.
function declaredNames(src) {
  const names = new Set();
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    // const { a, b } = require(...) / destructured assignment
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const part of m[1].split(',')) {
        // "a: b" binds b; "a = 1" binds a
        const bound = part.includes(':') ? part.split(':').pop() : part.split('=')[0];
        const name = bound.replace(/[^\w$]/g, '').trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

test('every name in a module.exports shorthand is defined in that file', () => {
  const files = jsFiles(SRC);
  assert.ok(files.length > 10, 'expected to find the backend source');

  const broken = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/module\.exports\s*=\s*\{([^}]*)\}\s*;/);
    if (!m) continue;

    const declared = declaredNames(src);
    for (const raw of m[1].split(',')) {
      const entry = raw.trim();
      // Skip renamed, spread and computed exports — this check only claims to
      // understand the shorthand form.
      if (!entry || entry.includes(':') || entry.startsWith('...')) continue;
      if (!/^[A-Za-z_$][\w$]*$/.test(entry)) continue;
      if (!declared.has(entry)) {
        broken.push(`${path.relative(ROOT, file)} exports "${entry}", which is not defined there`);
      }
    }
  }

  assert.deepEqual(broken, [], `\n${broken.join('\n')}\n`);
});
