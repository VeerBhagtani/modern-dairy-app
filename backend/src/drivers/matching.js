// Delivery matching engine.
//
// Compares what the GPS saw (visits) with what the order system says should
// have happened (delivery orders). It produces a verdict per pair plus the
// two kinds of leftover that actually matter operationally: a visit with no
// order behind it, and an order with no visit behind it.
//
// It does NOT decide that a delivery happened. A match means "a visit and an
// order line up in place and time" — strong evidence, not proof of handover.
// And it never invents an order: if the order system has no record, the answer
// is UNMATCHED_VISIT, not a fabricated delivery.

const { haversineM } = require('./geo');
const { SEGMENT_TYPE, CONFIDENCE } = require('./classification');
const { customerKey, orderWindow, PLAN_SOURCE } = require('./orderWindow');

const OUTCOME = {
  MATCHED: 'MATCHED',
  POSSIBLE: 'POSSIBLE',
  UNMATCHED_VISIT: 'UNMATCHED_VISIT',
  UNMATCHED_DELIVERY: 'UNMATCHED_DELIVERY',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
};

const ev = (code, detail, extra) => ({ code, detail, ...(extra || {}) });

// The location an order was expected to be delivered to: its own coordinates if
// the order system supplied them, otherwise the known restaurant's. If neither
// exists we cannot check distance, and we say so rather than assuming.
function expectedLocation(order, placesById, placesByCustomer) {
  if (Number.isFinite(order.lat) && Number.isFinite(order.lng)) return { lat: order.lat, lng: order.lng, source: 'order' };
  // By place id, or else by the customer the order is for — most order files
  // carry only a customer id, and without this such an order could never be
  // more than a POSSIBLE match however exactly the visit fitted it.
  const place = (order.placeId ? placesById.get(order.placeId) : null)
    || (order.customerId && placesByCustomer ? placesByCustomer.get(customerKey(order.customerId)) : null);
  if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)) return { lat: place.lat, lng: place.lng, source: 'restaurant_record' };
  return null;
}

/**
 * @param {Array} segments classified segments (visits are found inside)
 * @param {Array} orders   delivery orders for this driver/day
 * @param {Array} places   restaurants (for expected locations)
 * @param {object} ctx { driverId }
 * @param {object} cfg
 */
function matchDeliveries(segments, orders, places, ctx, cfg) {
  const placesById = new Map((places || []).map((p) => [p.id, p]));
  // A customer id that belongs to two restaurant rows is ambiguous: not used.
  const placesByCustomer = new Map();
  const dupCustomer = new Set();
  for (const p of places || []) {
    const k = customerKey(p.customerId);
    if (!k) continue;
    if (placesByCustomer.has(k)) dupCustomer.add(k); else placesByCustomer.set(k, p);
  }
  for (const c of dupCustomer) placesByCustomer.delete(c);
  const visits = segments.filter((s) => s.type === SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT);
  const tolMs = cfg.matchTimeToleranceMin * 60000;

  // ---- candidate pairs -------------------------------------------------
  const candidates = [];
  for (const visit of visits) {
    for (const order of orders || []) {
      if (!visit.place) continue;
      // The same restaurant: by our own id (a planned stop, or an order file
      // row matched to a restaurant by name), or by customer code.
      const samePlace = order.placeId && order.placeId === visit.place.id;
      const sameCustomer = customerKey(order.customerId) && customerKey(order.customerId) === customerKey(visit.place.customerId);
      if (!samePlace && !sameCustomer) continue;

      const loc = expectedLocation(order, placesById, placesByCustomer);
      const distanceM = loc ? haversineM(visit.stop.center, loc) : null;
      // Proximity alone never makes a match, but being outside the tolerance
      // radius does rule one out.
      if (distanceM != null && distanceM > cfg.matchRadiusM) continue;

      const win = orderWindow(order);
      const winStart = win ? win.start : null;
      const winEnd = win ? win.end : null;
      const inWindow = winStart != null && visit.endTs >= winStart && visit.startTs <= winEnd;
      const nearWindow = winStart != null && visit.endTs >= winStart - tolMs && visit.startTs <= winEnd + tolMs;
      if (winStart != null && !nearWindow) continue;

      const driverOk = !order.assignedDriverId || !ctx.driverId || order.assignedDriverId === ctx.driverId;
      // Distance in time from the middle of the window — the tie-break used to
      // decide which visit gets an order when several could.
      const midWin = winStart != null ? (winStart + winEnd) / 2 : visit.startTs;
      const timeDeltaMs = Math.abs(((visit.startTs + visit.endTs) / 2) - midWin);

      candidates.push({ visit, order, distanceM, inWindow, nearWindow, driverOk, timeDeltaMs, locSource: loc?.source || null });
    }
  }

  // Best pairs first: in-window beats near-window, then closest in time, then
  // closest in space. Deterministic, so the same input always matches the same
  // way — a requirement for reproducible reports.
  candidates.sort((a, b) => (
    (b.inWindow - a.inWindow)
    || (b.driverOk - a.driverOk)
    || (a.timeDeltaMs - b.timeDeltaMs)
    || ((a.distanceM ?? 1e9) - (b.distanceM ?? 1e9))
    || String(a.order.id).localeCompare(String(b.order.id))
  ));

  const matches = [];
  const orderTaken = new Set();
  const visitOrders = new Map();   // segmentId -> [orderId]

  for (const c of candidates) {
    // An order can be satisfied by one visit only. A visit may cover several
    // orders to the same customer — that is normal, and it is exactly why
    // distance is attributed per VISIT and never per order (see the note in
    // the returned summary).
    if (orderTaken.has(c.order.id)) continue;
    orderTaken.add(c.order.id);

    const fromPlan = c.order.source === PLAN_SOURCE;
    const evidence = [fromPlan
      ? ev('planned_stop', 'the driver planned this stop and the GPS shows a visit to it')
      : ev('customer_match', `order customer ${c.order.customerId || c.order.placeId} matches the geofenced location`)];
    if (c.distanceM != null) {
      evidence.push(ev('spatial_match', `stop centroid ${Math.round(c.distanceM)} m from the expected delivery location (${c.locSource})`, { distanceM: Math.round(c.distanceM) }));
    } else {
      evidence.push(ev('no_expected_location', 'the order system supplied no coordinates for this order'));
    }
    evidence.push(c.inWindow
      ? ev('time_match', 'visit falls inside the delivery window')
      : ev('time_near', `visit falls outside the delivery window but within the ${cfg.matchTimeToleranceMin} min tolerance`));

    let outcome;
    let confidence;
    if (c.inWindow && c.driverOk && c.distanceM != null) {
      outcome = OUTCOME.MATCHED; confidence = CONFIDENCE.HIGH;
    } else if (c.driverOk) {
      outcome = OUTCOME.POSSIBLE; confidence = CONFIDENCE.MEDIUM;
    } else {
      outcome = OUTCOME.NEEDS_REVIEW; confidence = CONFIDENCE.LOW;
      evidence.push(ev('driver_mismatch', `order is assigned to driver ${c.order.assignedDriverId}, this ride belongs to ${ctx.driverId}`));
    }
    // A planned stop visited is a delivery done, but on the driver's own word
    // about where they were going: never more than MEDIUM.
    if (fromPlan && outcome === OUTCOME.MATCHED) confidence = CONFIDENCE.MEDIUM;
    if (c.order.status && ['cancelled', 'returned'].includes(String(c.order.status).toLowerCase())) {
      outcome = OUTCOME.NEEDS_REVIEW;
      evidence.push(ev('order_status', `order status is "${c.order.status}"`));
    }

    matches.push({
      segmentId: c.visit.id,
      placeId: c.visit.place?.id || null,
      placeName: c.visit.place?.name || null,
      orderId: c.order.id,
      customerId: c.order.customerId,
      source: c.order.source || null,
      outcome,
      confidence,
      evidence,
      visitAt: c.visit.startTs,
      distanceM: c.distanceM == null ? null : Math.round(c.distanceM),
    });
    if (!visitOrders.has(c.visit.id)) visitOrders.set(c.visit.id, []);
    visitOrders.get(c.visit.id).push(c.order.id);
  }

  // ---- leftovers -------------------------------------------------------
  const unmatchedVisits = visits
    .filter((v) => !visitOrders.has(v.id))
    .map((v) => ({
      segmentId: v.id,
      placeId: v.place?.id || null,
      placeName: v.place?.name || null,
      customerId: v.place?.customerId || null,
      visitAt: v.startTs,
      dwellSec: v.stop?.dwellSec ?? null,
      outcome: OUTCOME.UNMATCHED_VISIT,
      // Absence of an order is not proof of wrongdoing. Most often it means the
      // order system has not been connected, or the visit was a collection.
      reason: (orders && orders.length)
        ? 'no delivery order for this customer lines up with this visit'
        : 'no order data was available for this day',
    }));

  // Only this driver's own orders. The day's orders are loaded fleet-wide (so
  // a visit to a customer assigned to someone else is still caught), but
  // listing every other driver's orders as "unmatched" on each ride buried
  // the ones that mattered under hundreds that did not.
  // An expected delivery with a halt there under the 2-minute minimum is
  // missed for that reason, and says so.
  const missedBecauseShort = (o) => {
    const win = orderWindow(o);
    const sv = (ctx.shortVisits || []).find((v) => (o.placeId ? v.placeId === o.placeId
      : customerKey(o.customerId) && customerKey(v.customerId) === customerKey(o.customerId))
      && (!win || (v.endTs >= win.start - cfg.matchTimeToleranceMin * 60000 && v.startTs <= win.end + cfg.matchTimeToleranceMin * 60000)));
    if (sv) {
      return { reason: `stopped only ${sv.dwellSec} s at ${sv.placeName} — under the ${Math.round(sv.minSec / 60)}-minute minimum, so not delivered`,
        missedReason: 'too_short', shortVisit: { startTs: sv.startTs, endTs: sv.endTs, dwellSec: sv.dwellSec } };
    }
    return { reason: o.source === PLAN_SOURCE ? 'planned by the driver, but no visit to it was recorded'
      : 'no GPS visit to this customer lines up with this order', missedReason: 'no_visit' };
  };

  const unmatchedOrders = (orders || [])
    .filter((o) => !orderTaken.has(o.id) && o.assignedDriverId && ctx.driverId && o.assignedDriverId === ctx.driverId)
    .map((o) => ({
      orderId: o.id,
      customerId: o.customerId,
      assignedDriverId: o.assignedDriverId || null,
      orderedAt: o.orderedAt || null,
      status: o.status || null,
      source: o.source || null,
      placeId: o.placeId || null,
      placeName: o.placeName || null,
      outcome: OUTCOME.UNMATCHED_DELIVERY,
      ...missedBecauseShort(o),
    }));

  return {
    matches,
    unmatchedVisits,
    shortVisits: (ctx.shortVisits || []).length,
    unmatchedOrders,
    summary: {
      visits: visits.length,
      matched: matches.filter((m) => m.outcome === OUTCOME.MATCHED).length,
      possible: matches.filter((m) => m.outcome === OUTCOME.POSSIBLE).length,
      needsReview: matches.filter((m) => m.outcome === OUTCOME.NEEDS_REVIEW).length,
      unmatchedVisits: unmatchedVisits.length,
      unmatchedOrders: unmatchedOrders.length,
      distanceNote: 'Distance is attributed per visit, never per order. Several orders to one address share one visit and one set of kilometres.',
    },
  };
}

module.exports = { OUTCOME, matchDeliveries };
