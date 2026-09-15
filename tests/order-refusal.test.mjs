// What the app tells a customer when Firestore refuses their order.
//
// Firestore answers a credit hold and a failed field validation with the same
// PERMISSION_DENIED — the rules deliberately never say which rule said no. The
// app used to resolve that ambiguity by picking one and asserting it: "Your
// account is on hold for new orders."
//
// That is wrong in the case that actually happened here. Deployed rules older
// than the installed app reject every order from every customer, and each of
// them is then told they owe money. They ring the office; the office checks
// the hold list; nobody is on it. The message sends both sides hunting for a
// debt that does not exist while the real fault — an undeployed rules file —
// goes unmentioned.
//
// So the app now decides from evidence it actually has (has this install ever
// had an order accepted?) and, when it cannot know, says only what is true.
// These assertions exist to stop the two messages collapsing back into one.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'www/index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  c ? pass++ : fail++;
  console.log((c ? '  PASS  ' : '  FAIL  ') + m);
  if (!c && d) console.log('        ' + String(d).split('\n').join('\n        '));
};

// ── run the real decision code ──
const pieces = [
  /let ORDER_BLOCKED = false;/,
  /let ORDER_REFUSAL = null;[^\n]*/,
  /function everPlacedSuccessfully\(\)\{[\s\S]*?\n\}/,
  /function markOrderBlocked\(\)\{[\s\S]*?\n\}/,
  /const REFUSAL_COPY = \{[\s\S]*?\n\};/,
  /function refusalCopy\(\)\{[^\n]*\}/,
].map((re) => (SRC.match(re) || [''])[0]);
ok(pieces.every(Boolean), 'the refusal logic can be read out of the app');

const sandbox = { DB: { orders: [] }, S: { screen: 'checkout' }, paint: () => {} };
vm.createContext(sandbox);
vm.runInContext(pieces.join('\n') + `
  ; globalThis.__set = (orders) => { DB.orders = orders; ORDER_REFUSAL = null; ORDER_BLOCKED = false; };
  ; globalThis.__refuse = () => { markOrderBlocked(); return { kind: ORDER_REFUSAL, blocked: ORDER_BLOCKED, copy: refusalCopy() }; };
  ; globalThis.__copy = () => REFUSAL_COPY;
`, sandbox);
const refuseWith = (orders) => { sandbox.__set(orders); return sandbox.__refuse(); };

// ── the case that bit us: a fresh install, stale rules ──
// Nothing from this install has ever been accepted, so the document shape is
// at least as likely to be the problem as the customer.
const fresh = refuseWith([{ orderNo: 1 }, { orderNo: 2 }]);   // no firestoreId anywhere
ok(fresh.kind === 'rejected', 'an install that never had an order accepted gets "rejected", not "on hold"');
ok(fresh.blocked === false,
  'and ordering stays available — a rejection is not a standing block, the next try may work');
ok(!/on hold/i.test(fresh.copy.banner),
  'the rejected banner does not accuse the customer of being on hold',
  fresh.copy.banner);
ok(/not|could not/i.test(fresh.copy.banner) && /charge/i.test(fresh.copy.banner),
  'it says what IS known: the order was not accepted and nothing was charged',
  fresh.copy.banner);
ok(/basket|cart/i.test(fresh.copy.banner), 'and that their basket is safe', fresh.copy.banner);

// ── a customer who HAS ordered before ──
// The rules have accepted this app's document shape from this install, so a
// refusal now points at the customer, not the payload. A hold is the honest call.
const known = refuseWith([{ orderNo: 1, firestoreId: 'abc123' }, { orderNo: 2 }]);
ok(known.kind === 'hold', 'an install with an accepted order behind it gets "hold"');
ok(known.blocked === true, 'and ordering IS stopped, because retrying a hold just fails again');
ok(/on hold/i.test(known.copy.banner), 'the hold banner says so plainly', known.copy.banner);
ok(known.copy.button === 'Account on hold', 'and the button explains why it is disabled');

// ── the two must stay different ──
const copy = sandbox.__copy();
ok(copy.hold.banner !== copy.rejected.banner, 'the two banners are not the same sentence');
ok(copy.hold.toast !== copy.rejected.toast, 'the two toasts are not the same sentence');
ok(copy.rejected.button === null,
  'the rejected state overrides no button label, so "Place order" stays offerable');

// ── it must not fall over on a broken store ──
sandbox.DB = null;
let threw = false;
try { vm.runInContext('markOrderBlocked()', sandbox); } catch (_) { threw = true; }
ok(!threw, 'a missing order store does not throw while handling a refusal');
sandbox.DB = { orders: [] };

// ── the app no longer hard-codes the old sentence anywhere ──
const hardcoded = SRC.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /Your account is on hold for new orders/.test(l))
  .filter(([, l]) => !/REFUSAL_COPY|banner:/.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
ok(hardcoded.length === 0,
  'the "on hold" sentence exists only in REFUSAL_COPY, not scattered through the screens',
  hardcoded.map(([n, l]) => 'line ' + n + ': ' + l.trim().slice(0, 90)).join('\n'));

// ── the refusal is debuggable at all ──
// The rules will not say which check failed, so the console line is the only
// thing anyone diagnosing this has; it must carry the error and name both
// causes rather than just saying "refused".
const warn = (SRC.match(/console\.warn\('Firestore refused the order write[\s\S]{0,400}?\);/) || [''])[0];
ok(/credit hold/i.test(warn) && /valid/i.test(warn) && /rules older/i.test(warn),
  'the console warning names both possible causes, including stale deployed rules');
ok(/, e\);?\s*$/.test(warn.trim()), 'and logs the raw error rather than swallowing it');

console.log('\nORDER REFUSAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
