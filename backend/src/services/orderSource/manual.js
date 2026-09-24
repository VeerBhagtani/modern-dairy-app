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

// A bare `YYYY-MM-DD HH:MM` from an Indian back office means IST, not UTC.
// Guessing UTC here would shift every delivery window by five and a half hours
// and quietly destroy the matching.
function parseTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return Date.parse(`${s.replace(' ', 'T')}+05:30`);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const { orderCoords } = require('./coords');

/**
 * @param {string} csvText
 * @param {Map} driverCodeToId  so a back office can write MD-014, not a uuid
 */
function parseOrdersCsv(csvText, driverCodeToId = new Map()) {
  const rows = parseCsv(csvText);
  if (!rows.length) return { orders: [], problems: ['file is empty'] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (name) => header.indexOf(name);
  const problems = [];
  for (const required of ['order_id', 'customer_id']) {
    if (idx(required) === -1) problems.push(`missing required column "${required}"`);
  }
  if (problems.length) return { orders: [], problems };

  const orders = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const at = (name) => (idx(name) === -1 ? null : (row[idx(name)] ?? '').trim());
    const driverCode = at('driver_code');
    const assignedDriverId = driverCode ? (driverCodeToId.get(driverCode) || null) : null;
    if (driverCode && !assignedDriverId) {
      // Reported, never guessed. An order attached to the wrong driver is worse
      // than an order attached to none.
      problems.push(`row ${r + 1}: driver code "${driverCode}" does not match any driver — imported unassigned`);
    }
    orders.push({
      externalId: at('order_id'),
      customerId: at('customer_id') || null,
      placeId: at('place_id') || null,
      assignedDriverId,
      orderedAt: parseTime(at('ordered_at')),
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
};
