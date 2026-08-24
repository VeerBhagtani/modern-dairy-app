/* Exercises the Bills tab's pure logic — filtering, the 14-section GST tax
   invoice, amount-in-words, the CGST/SGST vs IGST split, per-line
   reconciliation — straight out of the shipped admin page, with only the
   DOM/Firebase edges stubbed. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(process.argv[2] || path.join(ROOT, 'legal', 'admin', 'index.html'), 'utf8');
const src = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// Slice out just the Bills module.
const start = src.indexOf('/* ── Bills: bulk printing + reprint');
const end = src.indexOf('/* ── Products ');
if (start === -1 || end === -1 || end < start) throw new Error('could not locate the Bills module');
const bills = src.slice(start, end);

// Everything the module reaches for that lives elsewhere in the page.
const prelude = `
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => '₹' + Math.round(Number(n)||0).toLocaleString('en-IN');
const money2 = n => '₹' + (Number(n)||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtDate = ts => { const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null); return d ? d.toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'; };
const fmtBillDate = ts => { const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null); return d ? d.toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; };
const STATUS_LABEL = { placed:'Placed', confirmed:'Confirmed', delivered:'Delivered', cancelled:'Cancelled', denied:'Denied' };
const localStorage = { getItem: () => null, setItem: () => {} };
const document = { getElementById: () => null, querySelectorAll: () => [] };
const window = { print: () => {} };
const alert = () => {};
const db = {}, doc = () => ({}), serverTimestamp = () => 'TS', increment = () => 'INC', writeBatch = () => ({ update(){}, commit: async () => {} }), logAdmin = () => {};
const auth = { currentUser: { getIdToken: async () => 'fake-id-token' } };
globalThis.__calls = [];
const fetch = async (url, opts) => {
  globalThis.__calls.push({ url, opts });
  const r = globalThis.__fetchImpl ? globalThis.__fetchImpl(url, opts) : { ok: true, json: async () => ({ success: true, data: { created: true, gofrugal: { billNo: 'GF-' + globalThis.__calls.length } } }) };
  return r;
};
let cfg = { businessName:'Modern Dairy', address:'1942, Dr. Saldhana Street, Camp, Pune 411001', email:'info@moderndairy.in', supportPhone:'+919881232966', gstRate:0.05 };
let orders = [];
let openOrderId = null;
const closeModal = () => {};
`;

const mod = await import('data:text/javascript;base64,' + Buffer.from(
  prelude + bills +
  '\nexport { filteredBills, billHtml, billsListHtml, billActionsHtml, billTax, billLines, billOutstanding, amountInWords, billUsesPlaceholders, bf, stateLine, gofrugalOn, raiseGoFrugalBill, ensureGoFrugalBills, orders, cfg, BILL_PLACEHOLDERS, BILL_COPIES };\n' +
  'export function setOrders(v){ orders.length = 0; v.forEach(x => orders.push(x)); }\n' +
  'export function setCfg(patch){ Object.assign(cfg, patch); }\n' +
  'export function setScope(v){ billScope = v; }\nexport function setSearch(v){ billSearch = v; }\n' +
  'export function setUnprintedOnly(v){ billUnprintedOnly = v; }\nexport function setFormat(v){ billFormat = v; }\n' +
  'export function getFormatCss(){ return PAGE_CSS[billFormat]; }\n'
).toString('base64'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
};
const near = (a, b) => Math.abs(a - b) < 0.005;

const now = Date.now();
const day = 86400000;
const mk = (o) => ({
  id: o.id, orderNo: o.orderNo, status: o.status || 'delivered',
  placedAt: new Date(o.at), name: o.name, company: o.company, phone: o.phone,
  gstin: o.gstin, address: o.address, payment: o.payment,
  items: o.items || [{ name: 'Full Cream Milk', label: '1 L pouch', qty: 12, price: 33.5 }],
  subtotal: o.subtotal ?? 402, gst: o.gst ?? 20.1, delivery: o.delivery ?? 0,
  platform: o.platform ?? 2, total: o.total ?? 424.1,
  billPrintCount: o.printed || 0, billPrintedAt: o.printed ? new Date(o.at) : null,
  ...(o.extra || {}),
});

mod.setOrders([
  mk({ id:'a', orderNo:'MD-1041', at: now - 2*3600e3, company:'Sai Bakery', name:'Ramesh', phone:'9876543210', gstin:'27BBBBB1111B1Z5', address:'Shop 4, Camp' }),
  mk({ id:'b', orderNo:'MD-1042', at: now - 5*3600e3, name:'Priya', phone:'9812345678', printed:2 }),
  mk({ id:'c', orderNo:'MD-1030', at: now - 3*day, name:'Old Customer', phone:'9700000001' }),
  mk({ id:'d', orderNo:'MD-0900', at: now - 40*day, company:'Ancient Traders', phone:'9700000002' }),
  mk({ id:'e', orderNo:'MD-1043', at: now - 1*3600e3, name:'Cancelled Guy', phone:'9700000003', status:'cancelled' }),
  mk({ id:'f', orderNo:'MD-1044', at: now - 1*3600e3, name:'Denied Guy', phone:'9700000004', status:'denied' }),
]);

/* ── Filtering ─────────────────────────────────────────── */
mod.setSearch(''); mod.setUnprintedOnly(false);

mod.setScope('today');
let ids = mod.filteredBills().map(o => o.orderNo);
ok('Today shows only today\'s fulfilled bills', JSON.stringify(ids) === JSON.stringify(['MD-1041','MD-1042']), 'got ' + ids);
ok('cancelled + denied orders are never billed', !ids.includes('MD-1043') && !ids.includes('MD-1044'));

mod.setScope('7d');
ids = mod.filteredBills().map(o => o.orderNo);
ok('Last 7 days pulls in the 3-day-old bill', ids.includes('MD-1030') && !ids.includes('MD-0900'), 'got ' + ids);

mod.setScope('all');
ok('All loaded reaches the 40-day-old bill', mod.filteredBills().map(o=>o.orderNo).includes('MD-0900'));

mod.setScope('today'); mod.setUnprintedOnly(true);
ok('"not yet printed" hides the already-printed bill',
   JSON.stringify(mod.filteredBills().map(o=>o.orderNo)) === JSON.stringify(['MD-1041']));
mod.setUnprintedOnly(false);

/* ── Search: must reach past the date filter ───────────── */
mod.setScope('today');
mod.setSearch('MD-0900');
ok('search by bill number finds a 40-day-old bill while scope is Today',
   mod.filteredBills().map(o=>o.orderNo).join() === 'MD-0900');
mod.setSearch('ancient');
ok('search by company name (case-insensitive)', mod.filteredBills().map(o=>o.orderNo).join() === 'MD-0900');
mod.setSearch('Old Customer');
ok('search by customer name', mod.filteredBills().map(o=>o.orderNo).join() === 'MD-1030');
mod.setSearch('9812345678');
ok('search by phone', mod.filteredBills().map(o=>o.orderNo).join() === 'MD-1042');
mod.setSearch('cancelled guy');
ok('search still refuses to surface a cancelled order', mod.filteredBills().length === 0);
mod.setSearch('');

/* ── Amount in words (Indian numbering) ────────────────── */
ok('words: 0', mod.amountInWords(0) === 'Rupees Zero Only', mod.amountInWords(0));
ok('words: 424.10 keeps the paise', mod.amountInWords(424.10) === 'Rupees Four Hundred Twenty Four and Ten Paise Only', mod.amountInWords(424.10));
ok('words: exact rupees say Only', mod.amountInWords(2000) === 'Rupees Two Thousand Only');
ok('words: lakh grouping, not million', mod.amountInWords(250000) === 'Rupees Two Lakh Fifty Thousand Only', mod.amountInWords(250000));
ok('words: crore grouping', mod.amountInWords(12345678).startsWith('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight'));
ok('words: teens', mod.amountInWords(19) === 'Rupees Nineteen Only');

/* ── Line building + reconciliation ────────────────────── */
const charged = mk({ id:'p', orderNo:'MD-3000', at: now, name:'Multi', phone:'9700000010',
  items:[{name:'Milk',label:'1 L',qty:3,price:33.333},{name:'Curd',label:'400 g',qty:2,price:41.111}],
  subtotal: 182.22, gst: 9.11, delivery: 25, platform: 2, total: 218.33 });
let lines = mod.billLines(charged);
ok('every item becomes a printed line', lines.filter(l => !/Delivery|Platform/.test(l.name)).length === 2);
ok('delivery becomes its own 0% line', lines.some(l => l.name === 'Delivery charges' && l.taxRate === 0 && l.taxable === 25));
ok('platform fee becomes its own 0% line', lines.some(l => l.name === 'Platform fee' && l.taxRate === 0 && l.taxable === 2));
ok('line taxable reconciles to the charged subtotal + charges',
   near(lines.reduce((s,l)=>s+l.taxable,0), 182.22 + 25 + 2),
   String(lines.reduce((s,l)=>s+l.taxable,0)));
ok('line tax reconciles to the charged GST exactly',
   near(lines.reduce((s,l)=>s+l.tax,0), 9.11), String(lines.reduce((s,l)=>s+l.tax,0)));
let tt = mod.billTax(charged);
ok('taxable + tax + cess equals the invoice total',
   near(tt.taxable + tt.tax + tt.cess + tt.stateCess, charged.total),
   `${tt.taxable} + ${tt.tax} vs ${charged.total}`);
ok('a charge line carries a SAC code, not the goods HSN',
   lines.find(l => l.name === 'Delivery charges').hsn === '9968');
ok('unit falls back to the variant label', mod.billLines(mod.orders[0])[0].unit === '1 L pouch');

/* ── Tax split ─────────────────────────────────────────── */
const b2b = mod.orders.find(o => o.id === 'a');   // buyer GSTIN 27… = Maharashtra
let t = mod.billTax(b2b);
ok('same-state sale splits into CGST + SGST', !t.interState && near(t.cgst, 10.05) && near(t.sgst, 10.05) && t.igst === 0);
ok('the split adds back to exactly what was charged', near(t.cgst + t.sgst, b2b.gst));
ok('place of supply resolves the buyer state', t.place === '27 — Maharashtra', t.place);

const outState = mk({ id:'g', orderNo:'MD-2000', at: now, company:'Karnataka Foods', phone:'9700000005', gstin:'29ZZZZZ9999Z1Z5' });
t = mod.billTax(outState);
ok('other-state sale becomes IGST', t.interState && near(t.igst, 20.1) && t.cgst === 0);
ok('inter-state place of supply is the buyer state', t.place === '29 — Karnataka', t.place);

t = mod.billTax(mod.orders.find(o => o.id === 'b')); // no buyer GSTIN
ok('an unregistered buyer is treated as a local sale', !t.interState && t.cgst > 0);
ok('unregistered buyer falls back to the seller state', t.place === '27 — Maharashtra', t.place);

/* ── Multi-rate GST summary ────────────────────────────── */
const multi = mk({ id:'m', orderNo:'MD-4000', at: now, company:'Mixed Rate Foods', phone:'9700000011', gstin:'27CCCCC2222C1Z5',
  items:[{ name:'Milk', label:'1 L', qty:10, price:30, gstRate:0 }, { name:'Butter', label:'500 g', qty:2, price:250, gstRate:0.12 }],
  subtotal: 800, gst: 60, delivery: 0, platform: 0, total: 860 });
const mt = mod.billTax(multi);
ok('the GST summary groups by rate', mt.groups.length === 2, JSON.stringify(mt.groups.map(g=>g.rate)));
ok('a 0% group carries no tax', near(mt.groups.find(g=>g.rate===0).tax, 0));
ok('a 12% group carries the whole tax', near(mt.groups.find(g=>g.rate===12).tax, 60));
ok('group gross value = taxable + tax', mt.groups.every(g => near(g.gross, g.taxable + g.tax)));
ok('groups reconcile to the charged GST', near(mt.groups.reduce((s,g)=>s+g.tax,0), 60));

/* ── Account summary ───────────────────────────────────── */
let acct = mod.billOutstanding(b2b);
ok('outstanding is blank when the order carries no ledger figure', acct.prev === null && acct.total === null);
ok('current invoice is always the order total', near(acct.current, b2b.total));
acct = mod.billOutstanding(mk({ id:'l', orderNo:'MD-5000', at: now, name:'Ledger', phone:'9700000012', extra:{ prevOutstanding: 1500 } }));
ok('outstanding adds up when a ledger figure is stamped on the order',
   acct.prev === 1500 && near(acct.total, 1500 + 424.1), JSON.stringify(acct));

/* ── The 14 sections ───────────────────────────────────── */
const bill = mod.billHtml(b2b);
const has = (label, needle) => ok(label, bill.includes(needle), 'missing: ' + needle);
has('§1 seller GSTIN', 'GSTIN: <b>' + mod.BILL_PLACEHOLDERS.gstin);
has('§1 FSSAI no.', 'FSSAI No.: <b>' + mod.BILL_PLACEHOLDERS.fssai);
has('§1 MSME no.', 'MSME No.: <b>' + mod.BILL_PLACEHOLDERS.msme);
has('§1 Tel line', 'Tel:');
has('§1 Email line', 'Email:');
has('§2 E-Invoice Details block', 'E-Invoice Details');
has('§2 IRN field', '<td>IRN</td>');
has('§2 Ack No. field', '<td>Ack No.</td>');
has('§3 Transaction Details block', 'Transaction Details');
has('§3 Invoice No.', '<td>Invoice No.</td>');
has('§3 State Code &amp; Name', 'State Code &amp; Name');
has('§3 Date of Supply', 'Date of Supply');
has('§3 PO + PO Date', '<td>PO Date</td>');
has('§4 Party Details block', 'Party Details');
has('§5 product column headers', 'Name of Product');
has('§5 HSN column', 'HSN Code');
has('§5 Unit column', '>Unit<');
has('§5 Tax.Amt column', 'Tax.Amt (Rs)');
has('§5 Tax % column', 'Tax %');
has('§5 Total column', 'Total (Rs)');
has('§6 taxable strip', 'Taxable Amt (Rs)');
has('§6 cess columns', 'State Cess Amt');
has('§6 invoice total', 'Invoice Total (Rs)');
has('§7 amount in words', 'Amount in Words:');
has('§8 GST Tax Details block', 'GST Tax Details');
has('§8 G.Value column', 'G.Value');
has('§9 account summary', 'Customer Account Summary');
has('§9 prev outstanding', 'Prev Outstanding');
has('§9 total outstanding', '= Total Outstanding');
has('§10 declaration', 'Declaration:');
has('§11 GST verification note', 'GST Number:');
has('§12 jurisdiction', 'shall be subject to Pune jurisdiction only');
has('§13 IRN QR area', 'IRN QR Code');
has('§14 authorisation', 'Authorised Signatory');
has('§14 for-seller line', 'For <b>Modern Dairy</b>');

// An un-e-invoiced order must show an explicit dash in the IRN/Ack fields —
// a silently empty cell reads as a printing fault, not as "not applicable".
const irnRow = bill.match(/<td>IRN<\/td><th class="bill-brk">([^<]*)<\/th>/);
ok('the IRN field renders', !!irnRow, 'IRN row not found in the bill markup');
ok('an un-e-invoiced order prints a dash for IRN, not a blank', irnRow && irnRow[1].trim() === '—', irnRow && JSON.stringify(irnRow[1]));
const ackRow = bill.match(/<td>Ack No\.<\/td><th>([^<]*)<\/th>/);
ok('an un-e-invoiced order prints a dash for Ack No.', ackRow && ackRow[1].trim() === '—', ackRow && JSON.stringify(ackRow[1]));
ok('no fake QR image is emitted', !/<img[^>]+src="data:image/.test(bill));
ok('the QR area is reserved and labelled instead', bill.includes('prints once the'));
ok('a real IRP QR is rendered when the order carries one',
   mod.billHtml({ ...b2b, eInvoice:{ irn:'abc123', ackNo:'112233', qrImage:'data:image/png;base64,AAA' } }).includes('src="data:image/png;base64,AAA"'));
ok('the IRN prints when present', mod.billHtml({ ...b2b, eInvoice:{ irn:'abc123' } }).includes('abc123'));

ok('amount in words matches the total', bill.includes('Four Hundred Twenty Four and Ten Paise'));
ok('grand total prints with paise', bill.includes('₹424.10'));
ok('CGST and SGST are both shown on a local sale', bill.includes('CGST Amount') && bill.includes('SGST Amount'));
ok('bill number is shown', bill.includes('MD-1041'));
ok('the buyer GSTIN is shown', bill.includes('27BBBBB1111B1Z5'));
ok('the ship-to/party address is shown', bill.includes('Shop 4, Camp'));
ok('bank + UPI details are shown', bill.includes(mod.BILL_PLACEHOLDERS.bankIfsc) && bill.includes(mod.BILL_PLACEHOLDERS.upi));

/* ── Copies ────────────────────────────────────────────── */
ok('three copy labels exist', mod.BILL_COPIES.length === 3);
ok('default copy is Original for Recipient', bill.includes('Original for Recipient'));
ok('duplicate copy is labelled for the transporter', mod.billHtml(b2b, 'duplicate').includes('Duplicate for Transporter'));
ok('triplicate copy is labelled for the supplier', mod.billHtml(b2b, 'triplicate').includes('Triplicate for Supplier'));
ok('an unknown copy id falls back to Original', mod.billHtml(b2b, 'nonsense').includes('Original for Recipient'));
ok('a reprint notes when it was first printed', mod.billHtml(mod.orders.find(o=>o.id==='b')).includes('This is a reprint of a bill first printed'));

/* ── Placeholder handling ──────────────────────────────── */
ok('placeholders are flagged while Settings is empty', mod.billUsesPlaceholders());
ok('a placeholder bill warns it is not valid for tax', bill.includes('Not valid for tax purposes'));
mod.setCfg({ gstin:'27REAL1234R1Z5', pan:'REALP1234R', fssai:'99998888777766', msme:'UDYAM-MH-11-1111111', bankAccount:'123456789012', bankIfsc:'REAL0001234' });
ok('the warning clears once real values are saved', !mod.billUsesPlaceholders());
const realBill = mod.billHtml(b2b);
ok('a real bill drops the not-valid-for-tax line', !realBill.includes('Not valid for tax purposes'));
ok('real GSTIN overrides the specimen', realBill.includes('27REAL1234R1Z5') && !realBill.includes(mod.BILL_PLACEHOLDERS.gstin));
ok('a field left blank still falls back to its specimen', mod.bf('upi') === mod.BILL_PLACEHOLDERS.upi);
mod.setCfg({ gstin:'', pan:'', fssai:'', msme:'', bankAccount:'', bankIfsc:'' });

/* ── Editable legal text ───────────────────────────────── */
mod.setCfg({ declaration1:'Our own approved declaration.', gstinNote:'Our own approved GST note.', jurisdiction:'Mumbai' });
const custom = mod.billHtml(b2b);
ok('the declaration is admin-editable', custom.includes('Our own approved declaration.'));
ok('the GST verification note is admin-editable', custom.includes('Our own approved GST note.'));
ok('jurisdiction is admin-editable', custom.includes('subject to Mumbai jurisdiction only'));
mod.setCfg({ declaration1:'', gstinNote:'', jurisdiction:'' });

/* ── Legacy orders with no subtotal field ──────────────── */
const legacy = { id:'z', orderNo:'MD-0001', status:'delivered', placedAt:new Date(now),
  items:[{name:'Paneer',label:'200 g',qty:2,price:90}], gst:9, delivery:0, platform:2, total:191 };
lines = mod.billLines(legacy);
ok('an order with no subtotal field still produces sane lines', near(lines[0].taxable, 180));
ok('and still foots to its invoice total',
   near(mod.billTax(legacy).taxable + mod.billTax(legacy).tax, legacy.total));

/* ── XSS: customer-controlled text must not become markup ── */
const nasty = mk({ id:'x', orderNo:'MD-9999', at: now, name:'<img src=x onerror=alert(1)>', phone:'9700000009',
  items:[{ name:'<script>alert(2)</script>', label:'<b>bad</b>', qty:1, price:10 }] });
const nastyBill = mod.billHtml(nasty);
ok('customer name is escaped in the bill', !nastyBill.includes('<img src=x') && nastyBill.includes('&lt;img'));
ok('product name is escaped in the bill', !nastyBill.includes('<script>alert(2)'));
ok('the unit (from a variant label) is escaped', !nastyBill.includes('<b>bad</b>'));
mod.setOrders([...mod.orders, nasty]);
ok('customer name is escaped in the list row', !mod.billsListHtml().includes('<img src=x'));

/* ── Paper sizes ───────────────────────────────────────── */
mod.setFormat('a4');
ok('A4 sets an A4 @page rule', mod.getFormatCss().includes('A4'));
mod.setFormat('80mm');
ok('80mm sets a continuous 80mm roll @page rule', mod.getFormatCss() === '@page{size:80mm auto;margin:3mm;}');
mod.setFormat('58mm');
ok('58mm sets a continuous 58mm roll @page rule', mod.getFormatCss() === '@page{size:58mm auto;margin:2mm;}');
ok('the totals strip carries labels so a thermal roll can restack it',
   bill.includes('data-l="Invoice Total"') && bill.includes('data-l="Taxable Amt"'));

/* ── Buttons ───────────────────────────────────────────── */
mod.setFormat('a4'); mod.setScope('today'); mod.setSearch('');
const actions = mod.billActionsHtml();
ok('print-all button names the real count', /Print all \d+ bills?/.test(actions), actions);
ok('a "print only the new ones" button appears when some are already printed', actions.includes('not yet printed'));

/* ── GoFrugal: bill raised before printing ─────────────── */
ok('GoFrugal is off until both the URL and the toggle are set', !mod.gofrugalOn());
mod.setCfg({ gofrugalEnabled: true });
ok('the toggle alone does not switch it on', !mod.gofrugalOn());
mod.setCfg({ backendUrl: 'https://api.example.run.app/' });
ok('URL + toggle switches it on', mod.gofrugalOn());

globalThis.__calls = [];
const gfOrder = mk({ id:'gf1', orderNo:'MD-7001', at: now, company:'Test Co', phone:'9700000020' });
let out = await mod.ensureGoFrugalBills([gfOrder]);
ok('a bill with no GoFrugal number gets one raised', out.ok.length === 1 && out.raised === 1 && out.failed.length === 0);
ok('the trailing slash on the backend URL is not doubled',
   globalThis.__calls[0].url === 'https://api.example.run.app/admin/orders/gf1/bill', globalThis.__calls[0].url);
ok('the call is a POST carrying the Firebase ID token',
   globalThis.__calls[0].opts.method === 'POST' && globalThis.__calls[0].opts.headers.Authorization === 'Bearer fake-id-token');
ok('the returned bill number is merged onto the order', gfOrder.gofrugal.billNo === 'GF-1');

// Idempotency: the whole point of "print all" being safe to press twice.
globalThis.__calls = [];
out = await mod.ensureGoFrugalBills([gfOrder]);
ok('an already-billed order is never pushed again', globalThis.__calls.length === 0 && out.raised === 0 && out.ok.length === 1);

// A failure must remove that bill from the print set, not abort the batch.
globalThis.__calls = [];
const good = mk({ id:'gf2', orderNo:'MD-7002', at: now, name:'Good', phone:'9700000021' });
const bad  = mk({ id:'gf3', orderNo:'MD-7003', at: now, name:'Bad',  phone:'9700000022' });
globalThis.__fetchImpl = (url) => url.includes('gf3')
  ? { ok: false, status: 502, json: async () => ({ success: false, message: 'GoFrugal rejected the bill (502)' }) }
  : { ok: true, json: async () => ({ success: true, data: { created: true, gofrugal: { billNo: 'GF-OK' } } }) };
out = await mod.ensureGoFrugalBills([good, bad]);
ok('a failing bill is separated out, not thrown away silently', out.failed.length === 1 && out.failed[0].order.orderNo === 'MD-7003');
ok('the failure carries GoFrugal\'s message', /rejected the bill/.test(out.failed[0].message), out.failed[0].message);
ok('the other bills still succeed', out.ok.length === 1 && out.ok[0].orderNo === 'MD-7002');
globalThis.__fetchImpl = null;

// created:false is the backend saying "already billed" — must not count as new.
globalThis.__fetchImpl = () => ({ ok: true, json: async () => ({ success: true, data: { created: false, gofrugal: { billNo: 'GF-EXISTING' } } }) });
out = await mod.ensureGoFrugalBills([mk({ id:'gf4', orderNo:'MD-7004', at: now, name:'Existing', phone:'9700000023' })]);
ok('a bill the backend says already existed is not counted as newly raised', out.raised === 0 && out.ok.length === 1);
globalThis.__fetchImpl = null;

/* ── GoFrugal's number is the invoice number ───────────── */
const billed = { ...b2b, gofrugal: { billNo:'GF/2026/0042', billDate:new Date(now), irn:'a'.repeat(64), ackNo:'112233445566', ackDate:new Date(now), signedQr:'eyJhbGciOi...' } };
const billedHtml = mod.billHtml(billed);
ok('GoFrugal\'s bill number becomes the Invoice No.', /<td>Invoice No\.<\/td><th>GF\/2026\/0042<\/th>/.test(billedHtml));
ok('our own order number drops to an Order Ref. line', /<td>Order Ref\.<\/td><th>MD-1041<\/th>/.test(billedHtml));
ok('the IRN from GoFrugal is printed', billedHtml.includes('a'.repeat(64)));
ok('the Ack No. from GoFrugal is printed', billedHtml.includes('112233445566'));
ok('with a signed QR present the box says rendering is not yet enabled', billedHtml.includes('rendering not'));
ok('still no fake QR image is emitted', !/<img[^>]+src="data:image/.test(billedHtml));
ok('an unbilled order keeps showing our own number and no Order Ref.',
   /<td>Invoice No\.<\/td><th>MD-1041<\/th>/.test(bill) && !bill.includes('Order Ref.'));

/* ── The list surfaces the GoFrugal state ──────────────── */
mod.setOrders([billed, mk({ id:'nb', orderNo:'MD-7005', at: now, name:'Unbilled', phone:'9700000024' })]);
mod.setScope('all');
const listHtml = mod.billsListHtml();
ok('the list shows the GoFrugal bill number', listHtml.includes('GF/2026/0042'));
ok('the list flags an order not yet billed', listHtml.includes('Not billed'));
const mismatchHtml = mod.billsListHtml.call(null) && (mod.setOrders([{ ...billed, gofrugal: { ...billed.gofrugal, totalMismatch: true } }]), mod.billsListHtml());
ok('a total mismatch is flagged in the list', mismatchHtml.includes('total differs'));
mod.setCfg({ gofrugalEnabled: false, backendUrl: '' });

console.log('\nBILLS: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
