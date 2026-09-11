/* The Cancel button must disappear the moment an order goes out for delivery.
   Pulls the real scrOrder() source out of www/index.html and renders it against
   every status, so a future edit that re-widens the condition fails here. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(process.argv[2] || path.join(ROOT, 'www', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
};

/* ── The two lists must agree, or the UI offers a cancel the server refuses ── */
const appList = html.match(/const CANCELLABLE_STATUSES = \[([^\]]+)\];[^\n]*must match/);
ok('the app declares CANCELLABLE_STATUSES', !!appList);
const appStatuses = appList[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));

const rules = fs.readFileSync(path.join(ROOT, 'backend', 'firestore.rules'), 'utf8');
const ruleList = rules.match(/function isCancellable\(status\) \{\s*return status in \[([^\]]+)\]/);
ok('the rules declare isCancellable()', !!ruleList);
const ruleStatuses = ruleList[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));

ok('app and rules allow exactly the same statuses',
   JSON.stringify([...appStatuses].sort()) === JSON.stringify([...ruleStatuses].sort()),
   'app: ' + appStatuses + '  rules: ' + ruleStatuses);
ok('out_for_delivery is NOT cancellable', !appStatuses.includes('out_for_delivery'));
ok('delivered is NOT cancellable', !appStatuses.includes('delivered'));

/* ── Render the real scrOrder() for each status ───────────────────────────── */
const start = html.indexOf('function scrOrder(){');
const end = html.indexOf('\nfunction reorder(no){');
if (start === -1 || end === -1) throw new Error('could not locate scrOrder()');
const scrOrderSrc = html.slice(start, end);

const prelude = `
const CANCELLABLE_STATUSES = ${JSON.stringify(appStatuses)};
const STATUS = { placed:{l:'Placed',c:'a'}, confirmed:{l:'Confirmed',c:'a'},
  pending_confirmation:{l:'Pending confirmation',c:'a'}, packed:{l:'Packed',c:'a'},
  out_for_delivery:{l:'Out for delivery',c:'a'}, delivered:{l:'Delivered',c:'b'},
  cancelled:{l:'Cancelled',c:'c'}, denied:{l:'Denied',c:'c'} };
const esc = s => String(s ?? '');
const icon = () => '';
const money = n => 'Rs' + n;
const money2 = n => 'Rs' + n;
const dtFmt = () => '';
const navBar = () => '';
const stateBlock = () => '';
const rfdBlockHtml = () => '';
const APPCFG = { supportPhone:'+910000000000' };
const S = { order: null };
`;

const mod = await import('data:text/javascript;base64,' + Buffer.from(
  prelude + scrOrderSrc + '\nexport { scrOrder };\nexport function setOrder(o){ S.order = o; }\n'
).toString('base64'));

const mkOrder = (status) => ({
  orderNo: 'MD-1041', status, placedAt: new Date(), total: 100, gst: 5, platform: 2,
  items: [{ name: 'Milk', label: '1 L', qty: 1, price: 93 }],
  address: 'Shop 4, Camp', payment: 'cod',
});

const CANCEL_RE = /Cancel order<\/button>/;
const shows = (status) => {
  mod.setOrder(mkOrder(status));
  return CANCEL_RE.test(mod.scrOrder());
};

console.log('');
for (const st of appStatuses) {
  ok('cancel IS offered while ' + st, shows(st));
}
// The regression this test exists for.
ok('cancel is GONE the moment the order is out for delivery', !shows('out_for_delivery'));
ok('cancel is gone once delivered', !shows('delivered'));
ok('cancel is gone once cancelled', !shows('cancelled'));
ok('cancel is gone once denied', !shows('denied'));

/* ── The live listener must repaint, or "immediately" isn't true ──────────── */
ok('a status change repaints the order screen',
   /if\(changed( \|\| whyChanged)?\)\{[\s\S]{0,400}paint\(\);/.test(html));
ok('the confirm sheet is closed when the order stops being cancellable',
   /if\(!CANCELLABLE_STATUSES\.includes\(S\.order\?\.status\)\) closeSheet\(\);/.test(html));
ok('doCancelOrder refuses (and says so) if the status moved on',
   /if\(!CANCELLABLE_STATUSES\.includes\(o\.status\)\)\{[\s\S]{0,300}closeSheet\(\);/.test(html));

console.log('\nCANCEL-VISIBILITY: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
