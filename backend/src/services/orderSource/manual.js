// Manual order source: a CSV or Excel export from whatever system Modern Dairy
// is actually running today, uploaded by an admin.
//
// This is not a placeholder for a "real" integration — it is the integration
// that works on day one, before GoFrugal API access exists, and it is what
// raises restaurant visits from MEDIUM to HIGH confidence. Without any order
// data the platform still works; it just reports more MEDIUM and more UNKNOWN,
// honestly.
//
// Expected columns (header row, case-insensitive, extra columns ignored):
//   order_id, customer_id, driver_code, ordered_at, window_start, window_end,
//   delivered_at, status, lat, lng, place_id
// Times are ISO-8601, or `YYYY-MM-DD HH:MM` which is read as IST.

// Parses CSV properly rather than splitting on commas: a restaurant called
// "Kamat, Deccan" in a quoted field would otherwise shift every column after it.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// Times from an Indian back office, read as IST unless they say otherwise:
//   2026-09-25 14:30 · 2026-09-25        ISO-ish, date first
//   25/09/2026 2:30 PM · 25-09-2026      day first (never month first)
//   46290.6041                           an Excel date serial, as a sheet
//                                        export writes a date cell
// A date with no time is marked so the caller can treat it as the whole day.
// Guessing UTC would shift every window by five and a half hours; guessing
// month-first would put 05/09 in May.
const IST = '+05:30';
const pad = (n) => String(n).padStart(2, '0');

function clock(h, m, sec, ampm) {
  let hh = Number(h);
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12;
  }
  if (hh > 23 || Number(m) > 59) return null;
  return `${pad(hh)}:${pad(m)}:${pad(sec || 0)}`;
}

function parseTimeDetail(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Excel serial: days since 1899-12-30, local (IST) wall time.
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 864e5) - 5.5 * 3600e3;
      return { ms, dateOnly: Number.isInteger(serial) };
    }
    return null;
  }
  const TIME = '(?:[ T,]+(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?\\s*([AaPp][Mm])?)?';
  let m = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${TIME}$`).exec(s);
  let y; let mo; let d;
  if (m) { [, y, mo, d] = m; } else {
    m = new RegExp(`^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{2,4})${TIME}$`).exec(s);
    if (m) { [, d, mo, y] = m; if (y.length === 2) y = `20${y}`; }
  }
  if (m) {
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    const hasTime = m[4] != null;
    const t = hasTime ? clock(m[4], m[5], m[6], m[7]) : '00:00:00';
    if (!t) return null;
    const ms = Date.parse(`${y}-${pad(mo)}-${pad(d)}T${t}${IST}`);
    return Number.isFinite(ms) ? { ms, dateOnly: !hasTime } : null;
  }
  // Anything with its own zone (2026-09-25T09:00:00Z, …).
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? { ms, dateOnly: false } : null;
  }
  return null;
}

function parseTime(v) {
  const t = parseTimeDetail(v);
  return t ? t.ms : null;
}

// The office's own column names, whatever the back office calls them.
const ALIASES = {
  order_id: ['order_id', 'order_no', 'order_number', 'bill_no', 'bill_number', 'invoice_no', 'invoice_number', 'voucher_no', 'challan_no', 'doc_no'],
  customer_id: ['customer_id', 'customer_code', 'cust_id', 'cust_code', 'party_code', 'party_id', 'customer_no', 'account_code', 'client_code'],
  customer_name: ['customer_name', 'party_name', 'party', 'customer', 'restaurant', 'restaurant_name', 'hotel', 'hotel_name', 'outlet', 'name'],
  driver_code: ['driver_code', 'driver_id', 'driver', 'driver_name', 'delivery_boy', 'salesman', 'delivered_by'],
  ordered_at: ['ordered_at', 'order_date', 'order_time', 'bill_date', 'invoice_date', 'date', 'voucher_date', 'order_datetime', 'bill_datetime'],
  time: ['time', 'bill_time', 'invoice_time'],
  window_start: ['window_start', 'delivery_from', 'slot_start'],
  window_end: ['window_end', 'delivery_to', 'slot_end'],
  delivered_at: ['delivered_at', 'delivery_time', 'delivery_date', 'delivered_on', 'delivered_time'],
  status: ['status', 'order_status', 'delivery_status'],
  lat: ['lat', 'latitude'],
  lng: ['lng', 'lon', 'long', 'longitude'],
  place_id: ['place_id'],
};

const { orderCoords } = require('./coords');

/**
 * @param {string} csvText
 * @param {Map} driverCodeToId  so a back office can write MD-014, not a uuid
 */
function parseOrdersCsv(csvText, driverCodeToId = new Map(), driverNameToId = new Map()) {
  const rows = parseCsv(csvText);
  if (!rows.length) return { orders: [], problems: ['file is empty'] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const col = {};
  for (const [name, names] of Object.entries(ALIASES)) {
    const i = names.map((n) => header.indexOf(n)).find((x) => x !== -1);
    col[name] = i === undefined ? -1 : i;
  }
  const problems = [];
  if (col.order_id === -1) problems.push(`missing an order number column (any of: ${ALIASES.order_id.join(', ')})`);
  if (col.customer_id === -1 && col.customer_name === -1) problems.push(`missing a customer column — a code (any of: ${ALIASES.customer_id.join(', ')}) or a name (any of: ${ALIASES.customer_name.join(', ')})`);
  if (problems.length) return { orders: [], problems };

  const byName = new Map([...driverNameToId].map(([k, v]) => [String(k).trim().toLowerCase(), v]));
  const orders = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const at = (name) => (col[name] === -1 ? null : (row[col[name]] ?? '').trim());
    const driverRef = at('driver_code');
    const assignedDriverId = driverRef
      ? (driverCodeToId.get(driverRef) || driverCodeToId.get(driverRef.toUpperCase()) || byName.get(driverRef.toLowerCase()) || null)
      : null;
    if (driverRef && !assignedDriverId) {
      // Reported, never guessed. An order attached to the wrong driver is worse
      // than an order attached to none.
      problems.push(`row ${r + 1}: driver "${driverRef}" does not match any driver code or name — imported unassigned`);
    }
    // A date in one column and the time in another is common in bill exports.
    let ordered = parseTimeDetail(at('ordered_at'));
    const t = at('time');
    if (ordered && ordered.dateOnly && t) {
      const both = parseTimeDetail(`${String(at('ordered_at')).split(/[ T]/)[0]} ${t}`);
      if (both) ordered = both;
    }
    if (at('ordered_at') && !ordered) problems.push(`row ${r + 1}: could not read the date "${at('ordered_at')}"`);
    orders.push({
      externalId: at('order_id') ? at('order_id').replace(/\.0+$/, '') : at('order_id'),
      customerId: at('customer_id') ? at('customer_id').replace(/\.0+$/, '') : null,
      customerName: at('customer_name') || null,
      placeId: at('place_id') || null,
      assignedDriverId,
      orderedAt: ordered ? ordered.ms : null,
      orderedDateOnly: ordered ? ordered.dateOnly : false,
      windowStart: parseTime(at('window_start')),
      windowEnd: parseTime(at('window_end')),
      deliveredAt: parseTime(at('delivered_at')),
      status: at('status') || null,
      // Blank cells are "no location", never (0, 0); see coords.js.
      ...orderCoords(at('lat'), at('lng')),
      raw: Object.fromEntries(header.map((h, i) => [h, row[i] ?? null])),
    });
  }
  return { orders, problems };
}

// The adapter interface. `fetchOrders` is handed the already-parsed rows by the
// upload route, because a manual source has no server to call.
module.exports = {
  name: 'manual',
  description: 'CSV/Excel upload of order records from the current back office',
  async isConfigured() { return true; },
  async fetchOrders(params) { return (params && params.orders) || []; },
  parseOrdersCsv,
  parseCsv,
  parseTime,
  parseTimeDetail,
  ALIASES,
};
