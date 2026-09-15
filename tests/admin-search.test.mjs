// Admin command search — the index has to stay honest.
//
// A search result pointing at a control that no longer exists is worse than
// no search: it sends someone hunting through a tab for something that was
// renamed or removed, and they conclude the panel is broken. So this test
// pulls SEARCH_INDEX and runSearch straight out of the page and checks both
// halves: that every entry aims at a real tab and real on-screen text, and
// that typing the obvious word actually surfaces the right thing first.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'legal/admin/index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  c ? pass++ : fail++;
  console.log((c ? '  PASS  ' : '  FAIL  ') + m);
  if (!c && d) console.log('        ' + String(d).split('\n').join('\n        '));
};

// ── lift the real code out of the page and run it ──
const indexSrc = (SRC.match(/const SEARCH_INDEX = \[[\s\S]*?\n\];/) || [])[0];
const searchSrc = (SRC.match(/function runSearch\(q\)\{[\s\S]*?\n\}/) || [])[0];
ok(indexSrc && searchSrc, 'SEARCH_INDEX and runSearch can be read out of the page');

const sandbox = { acctFilter: null, orderFilter: null, rfdFilter: null };
vm.createContext(sandbox);
// `const` at the top level of a vm context is lexical, so it never lands on
// the sandbox object — hand it over explicitly.
vm.runInContext(indexSrc + '\n' + searchSrc + '\n; globalThis.__INDEX = SEARCH_INDEX;', sandbox);
const INDEX = sandbox.__INDEX;
const search = (q) => vm.runInContext(`runSearch(${JSON.stringify(q)})`, sandbox);

ok(Array.isArray(INDEX) && INDEX.length >= 30,
  `the index covers the panel (${INDEX.length} entries)`);

// ── every entry points at a tab that exists ──
const REAL_TABS = [...SRC.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
const tabSet = new Set(REAL_TABS);
ok(tabSet.size >= 10, `found the panel's real tabs (${[...tabSet].join(', ')})`);

const badTabs = INDEX.filter((e) => !tabSet.has(e.tab));
ok(badTabs.length === 0, 'every entry targets a tab that exists',
  badTabs.map((e) => `${e.label} -> ${e.tab}`).join('\n'));

const shapeless = INDEX.filter((e) => !e.label || !e.where || !e.tab);
ok(shapeless.length === 0, 'every entry has a label, a location and a tab',
  shapeless.map((e) => JSON.stringify(e)).join('\n'));

// ── every scroll-to anchor is text the panel actually renders ──
// Resolved against the tab's own body function PLUS any const array it maps
// over (the emergency switches are built from EMERGENCY_CONTROLS, so their
// labels live outside controlsBody itself).
function sourceForTab(tab) {
  const fn = tab === 'settings' ? 'settingsBody' : tab + 'Body';
  const body = (SRC.match(new RegExp('function ' + fn + '\\(\\)[\\s\\S]*?\\n\\}\\n')) || [''])[0];
  let src = body;
  for (const m of body.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
    const arr = SRC.match(new RegExp('const ' + m[1] + ' = \\[[\\s\\S]*?\\n\\];'));
    if (arr) src += '\n' + arr[0];
  }
  return src;
}
const tabSource = Object.fromEntries([...tabSet].map((t) => [t, sourceForTab(t)]));
ok(Object.values(tabSource).every((s) => s.length > 100), 'every tab body function was located');

const lostAnchors = INDEX.filter((e) => e.at)
  .filter((e) => !tabSource[e.tab].toLowerCase().includes(e.at.toLowerCase()));
ok(lostAnchors.length === 0,
  `every "scroll to this" anchor is text its tab really renders (${INDEX.filter((e) => e.at).length} checked)`,
  lostAnchors.map((e) => `[${e.tab}] "${e.at}"  <- ${e.label}`).join('\n'));

// ── the searches people will actually type ──
// This is the whole point of the feature: the control for clearing a customer
// hold sits under Controls, which is nobody's first guess, and hunting for it
// with a blocked customer waiting is exactly the wrong moment to be lost.
const EXPECT = [
  ['hold',            'controls', /hold/i],
  ['unblock',         'controls', /hold/i],
  ['blocked',         'controls', /hold/i],
  ['account on hold', 'controls', /hold/i],
  ['stop supply',     'controls', /hold/i],
  ['maintenance',     null,       /maintenance/i],
  ['gstin',           'settings', /gstin/i],
  ['delivery fee',    'settings', /delivery fee/i],
  ['minimum order',   'settings', /minimum order/i],
  ['cutoff',          'settings', /cutoff/i],
  ['upi',             'settings', /upi/i],
  ['password',        'settings', /password/i],
  ['broadcast',       'broadcasts', /broadcast/i],
  ['rider',           'drivers',  /rider/i],
  ['out for delivery','orders',   /out for delivery/i],
  ['b2b',             null,       /b2b|business/i],
];
for (const [q, wantTab, wantLabel] of EXPECT) {
  const hits = search(q);
  const top = hits[0];
  const good = top && wantLabel.test(top.label) && (!wantTab || top.tab === wantTab);
  ok(good, `"${q}" finds it first`,
    top ? `got "${top.label}" (${top.tab})` : 'no results at all');
}

// Ranking, pinned: several entries match "hold" equally well on text alone,
// and before `boost` existed the tie was broken by label length, which put the
// read-only list above the control that actually clears a hold. Searching
// "hold" with a blocked customer waiting means "let me fix this".
const topHold = search('hold')[0];
ok(topHold && topHold.at === 'Put this customer on hold',
  '"hold" puts the control that CLEARS a hold above the list that only shows them',
  topHold ? `top was "${topHold.label}"` : 'no results');

// Typing a whole phrase still works — the multi-word fallback.
ok(search('put customer on hold').some((h) => h.tab === 'controls' && /hold/i.test(h.label)),
  'a typed-out phrase still finds the hold control');

ok(search('').length === 0, 'an empty query returns nothing rather than the whole index');
ok(search('zzzzqqq').length === 0, 'nonsense returns nothing rather than a bad guess');
ok(search('hold').length <= 8, 'results are capped so the dropdown stays readable');

// ── the filter-setting callbacks touch only real globals ──
const holdInAccounts = INDEX.find((e) => e.tab === 'accounts' && e.run && /hold/i.test(e.label));
if (holdInAccounts) {
  sandbox.acctFilter = 'all';
  vm.runInContext(`__INDEX.find(e => e.tab==="accounts" && e.run && /hold/i.test(e.label)).run()`, sandbox);
  ok(sandbox.acctFilter === 'hold', 'the accounts hold entry actually sets acctFilter before the tab draws');
}
const runsUseKnownGlobals = INDEX.filter((e) => e.run)
  .map((e) => [e.label, String(e.run)])
  .filter(([, s]) => !/^\(\)\s*=>\s*\{\s*(acctFilter|orderFilter|rfdFilter)\s*=\s*'[\w_]+';\s*\}$/.test(s.replace(/\s+/g, ' ')));
ok(runsUseKnownGlobals.length === 0,
  'every entry\'s run() only sets a known filter variable — no hidden side effects',
  runsUseKnownGlobals.map(([l, s]) => l + ': ' + s).join('\n'));

// ── the wiring is present in the page ──
ok(/id="admin-search"/.test(SRC), 'the search input is in the header');
ok(/function wireSearch\(\)/.test(SRC) && /wireSearch\(\);/.test(SRC),
  'wireSearch is defined and called on every shell render');
ok(/e\.key !== '\/'/.test(SRC) && /t\.tagName === 'INPUT'/.test(SRC),
  'the "/" shortcut refuses to steal the key while someone is typing in a field');

console.log('\nADMIN SEARCH: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
