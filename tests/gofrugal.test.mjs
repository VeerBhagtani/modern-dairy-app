/* Exercises the GoFrugal adapters — the two functions that turn our order
   into GoFrugal's payload and its response back into the fields we print.
   These are the only shape-specific code in the integration, so they are the
   only part worth testing before API access is live. */
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { toGoFrugalBill, fromGoFrugalResponse } = require(path.join(ROOT, 'backend', 'src', 'services', 'goFrugalClient.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
};

const ORDER = {
  id: 'abc', orderNo: 'MD-1041', placedAt: new Date('2026-08-24T05:50:00Z'),
  company: 'Sai Bakery', name: 'Ramesh', phone: '9876543210',
  gstin: '27BBBBB1111B1Z5', address: 'Shop 4, Camp', payment: 'Credit — 15 days',
  items: [
    { pk: 'milk', vid: 'v1', name: 'Full Cream Milk', label: '1 L', qty: 24, price: 33.5 },
    { pk: 'butter', vid: 'v2', name: 'Table Butter', label: '500 g', qty: 4, price: 265, gofrugalItemCode: 'GF-BUT-500' },
  ],
  subtotal: 1864, gst: 93.2, delivery: 150, platform: 2, total: 2109.2,
};

/* ── Request payload ───────────────────────────────────── */
const body = toGoFrugalBill(ORDER, { outletId: 'OUT1', companyId: 'CO1' });
ok('outlet and company travel in the body', body.outletId === 'OUT1' && body.companyId === 'CO1');
ok('our order number is sent as the external reference', body.referenceNo === 'MD-1041');
ok('bill date is ISO', body.billDate === '2026-08-24T05:50:00.000Z', body.billDate);
ok('company is the customer name, contact person is the person',
   body.customer.name === 'Sai Bakery' && body.customer.contactPerson === 'Ramesh');
ok('buyer GSTIN is sent', body.customer.gstin === '27BBBBB1111B1Z5');
ok('every item becomes a line', body.items.length === 2);
ok('a GoFrugal item code is preferred when the product carries one', body.items[1].itemCode === 'GF-BUT-500');
ok('otherwise our product key is sent (and will need mapping)', body.items[0].itemCode === 'milk');
ok('line amount = rate x qty', body.items[0].amount === 24 * 33.5);
ok('delivery and platform ride as charges, not as items',
   body.charges.length === 2 && body.charges[0].code === 'DELIVERY' && body.charges[1].amount === 2);
ok('our own totals are sent for cross-checking', body.expected.invoiceTotal === 2109.2 && body.expected.taxAmount === 93.2);

const noCompany = toGoFrugalBill({ ...ORDER, company: null }, { outletId: 'OUT1' });
ok('a B2C order sends the person as the customer name and no contact person',
   noCompany.customer.name === 'Ramesh' && noCompany.customer.contactPerson === null);
ok('companyId is omitted entirely when there is none', !('companyId' in noCompany));
const noItems = toGoFrugalBill({ orderNo: 'X', items: null }, { outletId: 'O' });
ok('an order with no items does not throw', Array.isArray(noItems.items) && noItems.items.length === 0);

/* ── Response parsing ──────────────────────────────────── */
let r = fromGoFrugalResponse({ data: { bill: { billNo: 'GF/26/1', invoiceDate: '2026-08-24', invoiceTotal: 2109.2 },
  eInvoice: { Irn: 'i'.repeat(64), AckNo: '112233', AckDt: '2026-08-24 11:20:00', SignedQRCode: 'eyJhbGciOi' } } });
ok('bill number is read', r.billNo === 'GF/26/1');
ok('bill date is read', r.billDate === '2026-08-24');
ok('total is read as a number', r.total === 2109.2);
ok('IRN is read through the IRP capitalisation', r.irn === 'i'.repeat(64));
ok('Ack no. and date are read', r.ackNo === '112233' && r.ackDate === '2026-08-24 11:20:00');
ok('the signed QR payload is read', r.signedQr === 'eyJhbGciOi');

r = fromGoFrugalResponse({ invoiceNo: 'GF/26/2', netAmount: '500.50' });
ok('a flat response with no data wrapper still parses', r.billNo === 'GF/26/2' && r.total === 500.5);

r = fromGoFrugalResponse({ result: { bill: { docNo: 'GF/26/3' } } });
ok('a result wrapper and docNo alias parse', r.billNo === 'GF/26/3');

r = fromGoFrugalResponse({ data: { bill: { billNo: 'GF/26/4' } } });
ok('a bill with no e-invoice leaves the IRN fields null', r.irn === null && r.ackNo === null && r.signedQr === null);
ok('a missing total is null, never 0', r.total === null);

r = fromGoFrugalResponse({ data: { bill: { billNo: '   ' } } });
ok('a whitespace-only bill number is treated as missing', r.billNo === null);

r = fromGoFrugalResponse({});
ok('an empty response yields a null bill number rather than throwing', r.billNo === null);
r = fromGoFrugalResponse(null);
ok('a null response does not throw', r.billNo === null);

console.log('\nGOFRUGAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
