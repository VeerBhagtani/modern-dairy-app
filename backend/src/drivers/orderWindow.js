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

/* The stops a driver picked for a round, as the day's expected deliveries.
 *
 * Needs no order file: a planned stop the GPS saw a visit to is a delivery
 * done, one it did not is a delivery missed. It is the driver's own list, not
 * the office's, so it never raises a visit to "verified" on its own (see
 * classification.ordersSupporting) — an order file still does that.
 */
const PLAN_SOURCE = 'driver_plan';
function planOrders(ride, restaurants) {
  const byId = new Map((restaurants || []).map((p) => [p.id, p]));
  const seen = new Set();
  const out = [];
  for (const s of (ride && ride.plannedStops) || []) {
    if (!s || !s.placeId || seen.has(s.placeId)) continue;
    seen.add(s.placeId);
    const place = byId.get(s.placeId);
    out.push({
      id: `plan_${ride.id}_${s.placeId}`,
      source: PLAN_SOURCE,
      externalId: `plan:${s.placeId}`,
      placeId: s.placeId,
      customerId: place ? place.customerId || null : null,
      assignedDriverId: ride.driverId || null,
      windowStart: s.plannedAt,
      windowEnd: endOfDeliveryDay(s.plannedAt),
      placeName: place ? place.name : null,
    });
  }
  return out;
}

/* The places this driver was meant to go today: the round they planned and
 * the office orders assigned to them. Only these can be MISSED. A restaurant
 * the driver merely passed, or paused beside, is not a missed delivery.
 */
function expectedPlaces(orders, driverId) {
  const placeIds = new Set(); const keys = new Set();
  for (const o of orders || []) {
    if (o.source !== PLAN_SOURCE && !(o.assignedDriverId && o.assignedDriverId === driverId)) continue;
    if (o.placeId) placeIds.add(o.placeId);
    const k = customerKey(o.customerId);
    if (k) keys.add(k);
  }
  return {
    any: placeIds.size + keys.size > 0,
    has: (place) => !!place && (placeIds.has(place.id) || (!!customerKey(place.customerId) && keys.has(customerKey(place.customerId)))),
  };
}

module.exports = { customerKey, orderWindow, endOfDeliveryDay, planOrders, expectedPlaces, PLAN_SOURCE };
