/* Two rules every part of delivery matching must apply the same way.
 *
 * customerKey — the same customer written two ways must compare equal. Excel
 * drops leading zeros ("00123" → 123), back offices add spaces and change
 * case ("c-12" / "C-12 "). Compared raw, none of those ever matched a visit.
 *
 * orderWindow — when the delivery could have happened. Most order files carry
 * only the order (bill) time, often the evening before, or only a date. Read
 * as a single instant, such an order matched no visit hours later. So:
 *   windowStart..windowEnd                 if the file gives a window
 *   orderedAt..deliveredAt                 if it gives both
 *   orderedAt..end of the delivery day     otherwise; an order after 18:00
 *                                          IST is for the next day
 *   deliveredAt (± tolerance)              if that is all there is
 */
'use strict';

function customerKey(v) {
  if (v == null) return null;
  let s = String(v).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  // "123.0" is how a number column often arrives from a spreadsheet.
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
  return s;
}

const IST_MS = 5.5 * 3600000;
const DAY_MS = 864e5;
const NEXT_DAY_AFTER_HOUR = 18;

function endOfDeliveryDay(orderedAt) {
  const local = orderedAt + IST_MS;
  const dayStartLocal = Math.floor(local / DAY_MS) * DAY_MS;
  const hour = (local - dayStartLocal) / 3600000;
  const days = hour >= NEXT_DAY_AFTER_HOUR ? 2 : 1;
  return dayStartLocal + days * DAY_MS - IST_MS - 1;
}

const num = (x) => (Number.isFinite(x) ? x : null);

/* @returns { start, end } in epoch ms, or null if the order has no time. */
function orderWindow(o) {
  const ws = num(o.windowStart); const we = num(o.windowEnd);
  const oa = num(o.orderedAt); const da = num(o.deliveredAt);
  const start = ws ?? oa ?? da ?? we;
  if (start == null) return null;
  let end = we ?? da;
  if (end == null) end = oa != null ? endOfDeliveryDay(oa) : start;
  if (end < start) end = start;
  return { start, end };
}

module.exports = { customerKey, orderWindow, endOfDeliveryDay };
