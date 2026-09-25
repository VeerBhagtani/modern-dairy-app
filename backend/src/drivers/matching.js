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
    || (order.customerId && placesByCustomer ? placesByCustomer.get(order.customerId) : null);
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
    if (!p.customerId) continue;
    if (placesByCustomer.has(p.customerId)) dupCustomer.add(p.customerId); else placesByCustomer.set(p.customerId, p);
  }
  for (const c of dupCustomer) placesByCustomer.delete(c);
  const visits = segments.filter((s) => s.type === SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT);
  const tolMs = cfg.matchTimeToleranceMin * 60000;

  // ---- candidate pairs -------------------------------------------------
  const candidates = [];
  for (const visit of visits) {
    for (const order of orders || []) {
      if (!order.customerId || !visit.place || order.customerId !== visit.place.customerId) continue;

      const loc = expectedLocation(order, placesById, placesByCustomer);
      const distanceM = loc ? haversineM(visit.stop.center, loc) : null;
      // Proximity alone never makes a match, but being outside the tolerance
      // radius does rule one out.
      if (distanceM != null && distanceM > cfg.matchRadiusM) continue;

      const winStart = order.windowStart ?? order.orderedAt;
      const winEnd = order.windowEnd ?? order.deliveredAt ?? order.orderedAt;
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

    const evidence = [
      ev('customer_match', `order customer ${c.order.customerId} matches the geofenced location`),
    ];
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
    if (c.order.status && ['cancelled', 'returned'].includes(String(c.order.status).toLowerCase())) {
      outcome = OUTCOME.NEEDS_REVIEW;
      evidence.push(ev('order_status', `order status is "${c.order.status}"`));
    }

    matches.push({
      segmentId: c.visit.id,
      placeId: c.visit.place?.id || null,
      orderId: c.order.id,
      customerId: c.order.customerId,
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

  const unmatchedOrders = (orders || [])
    .filter((o) => !orderTaken.has(o.id))
    .map((o) => ({
      orderId: o.id,
      customerId: o.customerId,
      assignedDriverId: o.assignedDriverId || null,
      orderedAt: o.orderedAt || null,
      status: o.status || null,
      outcome: OUTCOME.UNMATCHED_DELIVERY,
      reason: o.assignedDriverId && ctx.driverId && o.assignedDriverId !== ctx.driverId
        ? 'assigned to a different driver'
        : 'no GPS visit to this customer lines up with this order',
    }));

  return {
    matches,
    unmatchedVisits,
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
