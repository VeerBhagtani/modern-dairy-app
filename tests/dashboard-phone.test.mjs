// The office dashboard on a phone.
//
// The layout itself was checked by rendering every tab at 360 and 390 pixels
// wide in Chromium, against fixture data: no sideways scrolling, every table
// stacked, every cell labelled. These tests hold the pieces that make it work
// in place, so a later edit cannot quietly undo it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the dashboard loads the table labeller, after the views that build the tables', () => {
  const html = read('dashboard/index.html');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.includes('responsive.js'));
  assert.ok(scripts.indexOf('responsive.js') > scripts.indexOf('views.js'));
});

test('the phone layout exists and stacks tables into cards', () => {
  const css = read('dashboard/theme.css');
  const at = css.indexOf('@media (max-width:720px)');
  assert.notEqual(at, -1, 'a phone breakpoint');
  const phone = css.slice(at);
  assert.match(phone, /table\.stack thead\{display:none;\}/);
  assert.match(phone, /content:attr\(data-label\)/, 'each value shows its column name');
  // iPhones zoom the page on focus for anything smaller, and never zoom back.
  assert.match(phone, /input,select,textarea\{font-size:16px;\}/);
  // The tabs are pinned at the very top on a phone, not under a bar that wraps.
  assert.match(phone, /\.topbar\{position:static;/);
  assert.match(phone, /\.tabs\{top:0;/);
});

test('every published script is cache-busted, including ones added later', () => {
  // A list of names skipped responsive.js; a phone would have kept an old copy.
  for (const wf of ['.github/workflows/dashboard.yml', '.github/workflows/deploy.yml']) {
    assert.ok(read(wf).includes('s#src=\\"([A-Za-z0-9_-]+)\\.js\\"#'), `${wf} stamps every top-level script`);
  }
});

test('cells are labelled with their column, and spanning messages are not', () => {
  // Just enough DOM for the labeller: it reads th text and writes data-label.
  const cell = (text, colSpan = 1) => {
    const attrs = {};
    return {
      textContent: text, colSpan, attrs, classList: { add() {} },
      hasAttribute: (k) => k in attrs, setAttribute: (k, v) => { attrs[k] = v; },
    };
  };
  const classes = () => ({ list: [], add(c) { this.list.push(c); } });
  const row = ['Ramesh', 'active', 'live', '12s'].map((t) => cell(t));
  const message = cell('No drivers match.', 4);
  const table = {
    tHead: { rows: [{ cells: ['Driver', 'Ride', 'Position', 'Updated'].map((t) => cell(t)) }] },
    tBodies: [{ rows: [{ cells: row }, { cells: [message] }] }],
    classList: classes(),
  };
  const small = { tHead: { rows: [{ cells: [cell('Key'), cell('Value')] }] }, tBodies: [], classList: classes() };

  vm.runInNewContext(read('dashboard/responsive.js'), {
    document: { getElementById: () => null, querySelectorAll: () => [table, small] },
    window: { requestAnimationFrame: (fn) => fn() },
    setTimeout: (fn) => fn(),
    MutationObserver: class { observe() {} },
  });

  assert.deepEqual(row.map((c) => c.attrs['data-label']), ['Driver', 'Ride', 'Position', 'Updated']);
  assert.equal(message.attrs['data-label'], '', 'a message across all columns gets no label');
  assert.deepEqual(table.classList.list, ['stack']);
  assert.deepEqual(small.classList.list, [], 'a two-column table is already a list and is left alone');
});
