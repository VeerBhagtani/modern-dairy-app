// GoFrugal RPOS / RetailEasy integration.
//
// ARCHITECTURE: GoFrugal is the billing system of record. When the admin
// presses Print in the Bills tab, the order is pushed here first; GoFrugal
// raises the bill, allots the legal invoice number and (where applicable)
// registers the e-invoice with the IRP. We then print GoFrugal's bill number
// and its IRN/QR — our own `orderNo` (MD-1041) is demoted to a reference.
// Two invoice numbers for one sale is not an option, so GoFrugal's wins.
//
// ── WHAT IS AND IS NOT CONFIRMED ──────────────────────────────────────────
// API access is not yet enabled on the Modern Dairy GoFrugal licence, so the
// request/response SHAPES below are the documented "Advanced Web API" pattern
// and are NOT verified against a live tenant. Everything shape-specific is
// deliberately confined to the two adapters at the bottom of this file —
// toGoFrugalBill() and fromGoFrugalResponse() — plus ENDPOINT/BASE_URL.
// When GoFrugal support enables API access and sends the docs, those are the
// only things that should need to change. See GOFRUGAL_INTEGRATION.md for the
// exact list of questions to put to them.
// ──────────────────────────────────────────────────────────────────────────

const { getSecret } = require('./secretManager');

const BASE_URL = process.env.GOFRUGAL_API_BASE_URL || 'https://api.gofrugal.com/rayapi/v1';
const ENDPOINT = process.env.GOFRUGAL_BILL_ENDPOINT || '/bills';
const TIMEOUT_MS = Number(process.env.GOFRUGAL_TIMEOUT_MS) || 20000;

async function creds() {
  const apiKey = await getSecret('gofrugal');
  const outletId = await getSecret('gofrugal_outlet_id');
  const companyId = await getSecret('gofrugal_company_id');
  if (!apiKey || !outletId) {
    const err = new Error('GoFrugal is not configured yet. Add the API key and outlet ID in Admin Panel → API keys.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return { apiKey, outletId, companyId };
}

/**
 * Raise a bill in GoFrugal for one order.
 *
 * IDEMPOTENCY IS THE CALLER'S JOB in the sense that it must not call this for
 * an order that already carries a bill number — but we also send our own
 * orderNo as the external reference on every request, so that a GoFrugal
 * tenant configured to reject duplicate references gives us a second line of
 * defence. "Print all 40 bills" pressed twice must never raise 80 bills.
 *
 * @returns {Promise<{billNo, billDate, irn, ackNo, ackDate, signedQr, raw}>}
 */
async function raiseBill(order) {
  const { apiKey, outletId, companyId } = await creds();

  const url = `${BASE_URL}${ENDPOINT}?outletId=${encodeURIComponent(outletId)}`
            + (companyId ? `&companyId=${encodeURIComponent(companyId)}` : '');

  // A hung billing call must not hold the admin's Print button forever.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Auth-Token': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(toGoFrugalBill(order, { outletId, companyId })),
      signal: ac.signal,
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError'
      ? `GoFrugal did not respond within ${TIMEOUT_MS / 1000}s. The bill may or may not have been raised — check in GoFrugal before retrying.`
      : `Could not reach GoFrugal: ${e.message}`);
    err.code = e.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`GoFrugal rejected the bill (${res.status}): ${text.slice(0, 300)}`);
    err.code = 'PROVIDER_ERROR';
    err.status = res.status;
    throw err;
  }

  let json;
  try { json = JSON.parse(text); }
  catch {
    const err = new Error(`GoFrugal returned a non-JSON response: ${text.slice(0, 200)}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  const parsed = fromGoFrugalResponse(json);
  if (!parsed.billNo) {
    // Printing a bill with no legal invoice number is worse than not printing.
    const err = new Error('GoFrugal accepted the request but returned no bill number. '
      + 'Check the response mapping in fromGoFrugalResponse() against the API docs.');
    err.code = 'PROVIDER_CONTRACT';
    err.raw = json;
    throw err;
  }
  return parsed;
}

/* ── Adapters ──────────────────────────────────────────────────────────────
   THESE TWO FUNCTIONS ARE THE ONLY GOFRUGAL-SHAPE-SPECIFIC CODE. Rewrite them
   against the real API docs; nothing above or outside this file should need
   to change.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Our order document → GoFrugal's bill payload.
 *
 * UNRESOLVED: item identity. GoFrugal bills by its own item code, and our
 * order items carry `pk` (product key) and `vid` (variant id), not a GoFrugal
 * code. Until every product in Firestore carries a `gofrugalItemCode`, this
 * sends our own identifiers and GoFrugal will not match them. Mapping the
 * catalogue is a prerequisite for going live — see GOFRUGAL_INTEGRATION.md.
 */
function toGoFrugalBill(order, { outletId, companyId }) {
  return {
    outletId,
    ...(companyId ? { companyId } : {}),
    // Our order number travels as the external reference so a bill can always
    // be traced back, and so a duplicate push is detectable on their side.
    referenceNo: order.orderNo,
    billDate: toIsoDate(order.placedAt),
    customer: {
      name: order.company || order.name || 'Customer',
      contactPerson: order.company ? (order.name || null) : null,
      mobile: order.phone || null,
      gstin: order.gstin || null,
      address: order.address || null,
    },
    items: (order.items || []).map((i, ix) => ({
      slNo: ix + 1,
      itemCode: i.gofrugalItemCode || i.sku || i.pk || null,
      variantCode: i.vid || null,
      description: i.name || '',
      qty: Number(i.qty) || 0,
      rate: Number(i.price) || 0,
      amount: (Number(i.price) || 0) * (Number(i.qty) || 0),
    })),
    charges: [
      ...(Number(order.delivery) ? [{ code: 'DELIVERY', amount: Number(order.delivery) }] : []),
      ...(Number(order.platform) ? [{ code: 'PLATFORM', amount: Number(order.platform) }] : []),
    ],
    // Sent for cross-checking only. GoFrugal recomputes tax from its own
    // masters; if its total disagrees with ours the caller surfaces that
    // rather than quietly printing a different number than the customer paid.
    expected: {
      taxableAmount: Number(order.subtotal) || 0,
      taxAmount: Number(order.gst) || 0,
      invoiceTotal: Number(order.total) || 0,
    },
    paymentMode: order.payment || null,
  };
}

/**
 * GoFrugal's response → the fields we store on the order and print.
 *
 * Written defensively across the casings GoFrugal's editions are documented
 * to use, so a minor naming difference degrades to "field missing" rather
 * than to a crash.
 */
function fromGoFrugalResponse(json) {
  const d = json?.data ?? json?.result ?? json ?? {};
  const bill = d.bill ?? d.invoice ?? d;
  const ei = d.eInvoice ?? d.einvoice ?? bill.eInvoice ?? bill.einvoice ?? {};
  const pick = (obj, ...keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };
  return {
    billNo:   pick(bill, 'billNo', 'billNumber', 'invoiceNo', 'invoiceNumber', 'docNo'),
    billDate: pick(bill, 'billDate', 'invoiceDate', 'docDate'),
    irn:      pick(ei, 'irn', 'Irn', 'IRN'),
    ackNo:    pick(ei, 'ackNo', 'AckNo', 'acknowledgementNo'),
    ackDate:  pick(ei, 'ackDate', 'AckDt', 'acknowledgementDate'),
    // The IRP's signed QR payload. This is the ONLY valid source for the
    // e-invoice QR — never synthesise one locally.
    signedQr: pick(ei, 'signedQRCode', 'SignedQRCode', 'qrCode', 'signedQr'),
    total:    numOrNull(pick(bill, 'invoiceTotal', 'billAmount', 'netAmount', 'total')),
    raw: json,
  };
}

function toIsoDate(ts) {
  const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : new Date());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
function numOrNull(v) {
  // Number(null) is 0, so a plain Number.isFinite() check would turn "GoFrugal
  // didn't send a total" into "GoFrugal says the total is zero" — which then
  // trips the mismatch warning on every single bill.
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { raiseBill, toGoFrugalBill, fromGoFrugalResponse };
