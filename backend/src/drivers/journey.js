/* The whole journey of a ride, in order, from the GPS that was recorded.
 *
 * Built from two things and nothing else:
 *   - the replay points (services/replay.js): every fix in time order, with
 *     the running distance measured along the cleaned track up to it;
 *   - the calculated segments: where the driver stopped, and what each stop
 *     and stretch counted as.
 *
 * Out of them comes what the office reads:
 *   stops     every place the driver stayed (radius and minimum time are the
 *             stopRadiusM / stopMinDwellSec settings), each visit separately,
 *             even the same restaurant twice — arrival, departure, how long,
 *             where, what it was, how far from the last stop and from the
 *             depot
 *   segments  the travel between consecutive stops (and from the start to
 *             the first, and from the last to the end): times, distance along
 *             the GPS (never a straight line between stops), what it counted
 *             as, and how good the GPS was
 *   events    the timeline: ride started → travelled → stop → travelled → …
 *
 * A stop is called personal only when the driver declared it or an admin set
 * it; a place that is neither a restaurant nor the depot is an Unknown stop.
 * Nothing is dropped: an excluded fix is still in the points, an unknown stop
 * is still in the timeline. Pure: same input, same journey.
 */
'use strict';

const { haversineM } = require('./geo');
const { SEGMENT_TYPE, BUSINESS_TYPES } = require('./classification');

const CATEGORY = {
  MODERN_DAIRY: 'MODERN_DAIRY',
  RESTAURANT: 'RESTAURANT',
  BUSINESS: 'BUSINESS',          // set to business by an admin, no restaurant record
  UNKNOWN: 'UNKNOWN',
  PERSONAL: 'PERSONAL',
  MISSED: 'MISSED',              // at a restaurant, but under the 2-minute minimum
};
const CATEGORY_LABEL = {
  MODERN_DAIRY: 'Modern Dairy',
  RESTAURANT: 'Restaurant',
  BUSINESS: 'Modern Dairy customer',
  UNKNOWN: 'Unknown stop',
  PERSONAL: 'Personal / excluded',
  MISSED: 'Missed delivery (under 2 min)',
};

function decidedByPerson(seg) {
  return !!seg.reviewedBy || (seg.evidence || []).some((e) => e.code === 'driver_declared');
}

function categoryOf(seg) {
  if (seg.type === SEGMENT_TYPE.MODERN_DAIRY_FACILITY_STOP || (seg.place && seg.place.kind === 'facility')) return CATEGORY.MODERN_DAIRY;
  if (seg.type === SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS) return decidedByPerson(seg) ? CATEGORY.PERSONAL : CATEGORY.UNKNOWN;
  if (seg.missedDelivery && !seg.reviewedBy) return CATEGORY.MISSED;
  if (seg.place && seg.place.kind === 'restaurant' && seg.type !== SEGMENT_TYPE.UNKNOWN) return CATEGORY.RESTAURANT;
  if (seg.reviewedBy && BUSINESS_TYPES.has(seg.type)) return CATEGORY.BUSINESS;
  return CATEGORY.UNKNOWN;
}

/* Running distance at a moment: the last point at or before it. */
function makeCum(points) {
  const ts = points.map((p) => p.ts);
  return (t) => {
    if (!points.length || t == null) return { d: 0, g: 0 };
    let lo = 0; let hi = ts.length - 1; let at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at < 0) return { d: 0, g: 0 };
    return { d: points[at].d || 0, g: points[at].g || 0 };
  };
}

/* What a stretch of points counted as, metre by metre. */
function kindsBetween(points, fromTs, toTs) {
  const by = {}; let prevD = null; let prevG = null; let n = 0; let excluded = 0; let accSum = 0; let accN = 0;
  for (const p of points) {
    if (p.ts < fromTs) { if (p.used) { prevD = p.d || 0; prevG = p.g || 0; } continue; }
    if (p.ts > toTs) break;
    n += 1;
    if (!p.used) { excluded += 1; continue; }
    if (Number.isFinite(p.a)) { accSum += p.a; accN += 1; }
    if (prevD != null) {
      const dd = (p.d || 0) - prevD; const dg = (p.g || 0) - prevG;
      if (dd > 0) by[p.b || 'unknown'] = (by[p.b || 'unknown'] || 0) + dd;
      if (dg > 0) by.gap = (by.gap || 0) + dg;
    }
    prevD = p.d || 0; prevG = p.g || 0;
  }
  return { by, n, excluded, avgAccuracyM: accN ? Math.round(accSum / accN) : null };
}

function quality({ n, excluded, avgAccuracyM }, gapM) {
  if (!n) return { grade: 'NO_GPS', note: 'no GPS fixes in this stretch' };
  const share = excluded / n;
  const notes = [];
  if (share > 0.2) notes.push(`${Math.round(share * 100)}% of fixes left out`);
  if (avgAccuracyM != null && avgAccuracyM > 50) notes.push(`typical accuracy ${avgAccuracyM} m`);
  if (gapM > 0) notes.push(`${(gapM / 1000).toFixed(2)} km across a GPS gap (estimated)`);
  const grade = share > 0.4 || gapM > 1000 ? 'POOR' : (notes.length ? 'FAIR' : 'GOOD');
  return { grade, note: notes.join('; ') || 'good GPS', fixes: n, excluded, avgAccuracyM };
}

function dominant(by) {
  let best = null; let bestM = 0;
  for (const [k, m] of Object.entries(by)) if (m > bestM) { best = k; bestM = m; }
  return best;
}

/**
 * @param ride        { id, startedAt, stoppedAt, status }
 * @param processing  the saved calculation (segments), or null
 * @param replay      buildReplay output (points with d/g)
 * @param places      { facilities, restaurants } — for addresses and depot distance
 */
function buildJourney({ ride, processing, replay, places = {} }) {
  const points = ((replay && replay.points) || []).slice().sort((a, b) => a.ts - b.ts);
  const used = points.filter((p) => p.used);
  const cum = makeCum(used);
  const facilities = places.facilities || [];
  const byId = new Map([...(places.restaurants || []), ...facilities].map((p) => [p.id, p]));
  const segs = ((processing && processing.segments) || []).slice().sort((a, b) => a.startTs - b.startTs);
  const active = ride.status === 'active';
  const first = points[0] || null;
  const last = points[points.length - 1] || null;
  const rideStart = first ? first.ts : ride.startedAt;
  const rideEnd = last ? last.ts : (ride.stoppedAt || ride.startedAt);

  const nearestDepot = (at) => {
    let best = null;
    for (const f of facilities) {
      if (!Number.isFinite(f.lat)) continue;
      const m = haversineM(at, f);
      if (!best || m < best.m) best = { m, place: f };
    }
    return best;
  };

  // ── stops ──
  const stops = [];
  let lastDepotLeftTs = null;
  segs.filter((s) => s.kind === 'stop').forEach((s, i, all) => {
    const category = categoryOf(s);
    const place = s.place ? byId.get(s.place.id) || s.place : null;
    const center = s.center || (s.stop && s.stop.center) || null;
    const arrive = cum(s.startTs); const leave = cum(s.endTs);
    const prev = stops[stops.length - 1];
    const fromTs = prev ? prev.departureTs : rideStart;
    const fromCum = cum(fromTs);
    const depot = center ? nearestDepot(center) : null;
    const isLast = i === all.length - 1;
    const stillHere = active && isLast && last && s.endTs >= last.ts - 60000;
    const st = {
      n: stops.length + 1,
      segmentId: s.id,
      category,
      label: category === CATEGORY.MODERN_DAIRY || category === CATEGORY.RESTAURANT ? (s.place && s.place.name)
        : category === CATEGORY.MISSED ? `Missed delivery: ${s.place ? s.place.name : 'restaurant'}`
          : s.passedBy ? `Paused by ${s.passedBy.name} (not in plan)` : CATEGORY_LABEL[category],
      // A restaurant not on today's round: passed briefly, or visited extra.
      passedBy: s.passedBy || null,
      notInPlan: !!s.notInPlan,
      placeId: s.place ? s.place.id : null,
      placeName: s.place ? s.place.name : null,
      address: place && place.address ? place.address : null,
      transit: !!s.transit,
      arrivalTs: s.startTs,
      departureTs: stillHere ? null : s.endTs,
      durationSec: Math.round(((stillHere ? last.ts : s.endTs) - s.startTs) / 1000),
      lat: center ? center.lat : null,
      lng: center ? center.lng : null,
      medianAccuracyM: s.medianAccuracyM ?? (s.stop && s.stop.medianAccuracyM) ?? null,
      distanceFromPrevM: Math.max(0, arrive.d - fromCum.d),
      gapFromPrevM: Math.max(0, arrive.g - fromCum.g),
      totalBeforeM: arrive.d,
      sinceDepotM: lastDepotLeftTs != null ? Math.max(0, arrive.d - cum(lastDepotLeftTs).d) : null,
      depotStraightM: depot && category !== CATEGORY.MODERN_DAIRY ? Math.round(depot.m) : (category === CATEGORY.MODERN_DAIRY ? 0 : null),
      type: s.type,
      confidence: s.confidence,
      needsReview: !!s.needsReview,
      reviewedBy: s.reviewedBy || null,
      originalType: s.originalType || null,
      nearbyPlaces: s.nearbyPlaces || null,
      evidence: (s.evidence || []).map((e) => e.detail),
      _leftCum: leave,
    };
    stops.push(st);
    if (category === CATEGORY.MODERN_DAIRY && st.departureTs) lastDepotLeftTs = st.departureTs;
  });

  // ── where the ride began and ended ──
  const at = (p) => (p ? { lat: p.lat, lng: p.lng } : null);
  const placeAt = (p) => {
    if (!p) return null;
    const d = nearestDepot(p);
    if (d && d.m <= 200) return { label: d.place.name, category: CATEGORY.MODERN_DAIRY };
    return null;
  };
  const startStop = stops[0] && stops[0].arrivalTs - rideStart <= 60000 ? stops[0] : null;
  const endStop = stops.length && (stops[stops.length - 1].departureTs == null || rideEnd - stops[stops.length - 1].departureTs <= 60000) ? stops[stops.length - 1] : null;
  const startPlace = startStop ? { label: startStop.label, category: startStop.category } : placeAt(first) || { label: 'Ride start', category: null };
  const endPlace = endStop ? { label: endStop.label, category: endStop.category } : placeAt(last) || { label: active ? 'Latest position' : 'Ride end', category: null };

  // ── travel segments between stops ──
  const segments = [];
  const ends = [{ label: startPlace.label, ts: rideStart, n: null, category: startPlace.category }]
    .concat(stops.map((s) => ({ stop: s })));
  for (let i = 0; i < ends.length; i += 1) {
    const from = ends[i];
    const to = ends[i + 1] || { label: endPlace.label, ts: rideEnd, category: endPlace.category, end: true };
    const fromTs = from.stop ? (from.stop.departureTs ?? rideEnd) : from.ts;
    const toTs = to.stop ? to.stop.arrivalTs : to.ts;
    if (from.stop && from.stop.departureTs == null) break;      // still at the last stop
    if (toTs <= fromTs) continue;                                // a stop that begins the ride
    const a = cum(fromTs); const b = cum(toTs);
    const k = kindsBetween(points, fromTs, toTs);
    const distanceM = Math.max(0, b.d - a.d); const gapM = Math.max(0, b.g - a.g);
    if (to.end && distanceM < 20 && gapM === 0) continue;       // nothing after the last stop
    segments.push({
      n: segments.length + 1,
      from: from.stop ? { label: from.stop.label, n: from.stop.n, category: from.stop.category } : { label: from.label, category: from.category },
      to: to.stop ? { label: to.stop.label, n: to.stop.n, category: to.stop.category } : { label: to.label, category: to.category, end: true },
      startTs: fromTs,
      endTs: toTs,
      durationSec: Math.round((toTs - fromTs) / 1000),
      distanceM,
      gapEstimateM: gapM,
      byKind: k.by,
      classification: dominant(k.by) || 'unknown',
      quality: quality(k, gapM),
    });
  }

  // ── the timeline ──
  const events = [{ kind: 'start', ts: rideStart, label: startPlace.label, category: startPlace.category, at: at(first) }];
  let si = 0;
  for (const st of stops) {
    while (si < segments.length && segments[si].to.n === st.n) {
      const g = segments[si];
      if (g.distanceM > 0 || g.gapEstimateM > 0) events.push({ kind: 'travel', ts: g.startTs, endTs: g.endTs, segment: g.n, distanceM: g.distanceM, gapEstimateM: g.gapEstimateM, durationSec: g.durationSec, classification: g.classification });
      si += 1;
    }
    events.push({ kind: 'stop', ts: st.arrivalTs, endTs: st.departureTs, stop: st.n, label: st.label, category: st.category, transit: st.transit,
      durationSec: st.durationSec, distanceFromPrevM: st.distanceFromPrevM, totalBeforeM: st.totalBeforeM, at: { lat: st.lat, lng: st.lng } });
  }
  for (; si < segments.length; si += 1) {
    const g = segments[si];
    if (g.distanceM > 0 || g.gapEstimateM > 0) events.push({ kind: 'travel', ts: g.startTs, endTs: g.endTs, segment: g.n, distanceM: g.distanceM, gapEstimateM: g.gapEstimateM, durationSec: g.durationSec, classification: g.classification });
  }
  // Halts at a restaurant too short to be a delivery (under 2 minutes), in
  // their place in the day. Those already shown as a stop are not repeated.
  const shortVisits = ((processing && processing.shortVisits) || [])
    .filter((v) => !stops.some((s) => s.arrivalTs <= v.endTs && (s.departureTs ?? Infinity) >= v.startTs));
  for (const v of shortVisits) {
    events.push({ kind: 'missed', ts: v.startTs, endTs: v.endTs, label: v.placeName, placeId: v.placeId, durationSec: v.dwellSec, minSec: v.minSec,
      at: { lat: v.lat, lng: v.lng }, totalBeforeM: cum(v.startTs).d });
  }
  // Restaurants not on today's round that the driver halted beside for under
  // 2 minutes: passing, not deliveries and not missed. Shown apart.
  const overlapsStop = (v) => stops.some((st) => st.arrivalTs <= v.endTs && (st.departureTs ?? Infinity) >= v.startTs);
  const passedHalts = ((processing && processing.passedBy) || []).filter((v) => !overlapsStop(v));
  for (const v of passedHalts) {
    events.push({ kind: 'passed', ts: v.startTs, endTs: v.endTs, label: v.placeName, placeId: v.placeId, durationSec: v.dwellSec,
      at: { lat: v.lat, lng: v.lng }, totalBeforeM: cum(v.startTs).d });
  }
  const notInPlan = [
    ...passedHalts.map((v) => ({ kind: 'passed', placeId: v.placeId, placeName: v.placeName, startTs: v.startTs, endTs: v.endTs, durationSec: v.dwellSec, lat: v.lat, lng: v.lng })),
    ...stops.filter((st) => st.passedBy).map((st) => ({ kind: 'passed', stop: st.n, placeId: st.passedBy.id, placeName: st.passedBy.name, startTs: st.arrivalTs, endTs: st.departureTs, durationSec: st.durationSec, lat: st.lat, lng: st.lng })),
    ...stops.filter((st) => st.notInPlan).map((st) => ({ kind: 'visited', stop: st.n, placeId: st.placeId, placeName: st.placeName, startTs: st.arrivalTs, endTs: st.departureTs, durationSec: st.durationSec, lat: st.lat, lng: st.lng })),
  ].sort((a, b) => a.startTs - b.startTs);
  events.sort((a, b) => a.ts - b.ts || (a.kind === 'start' ? -1 : b.kind === 'start' ? 1 : 0));
  events.push({ kind: active ? 'now' : 'end', ts: rideEnd, label: endPlace.label, category: endPlace.category, at: at(last), totalM: used.length ? used[used.length - 1].d || 0 : 0 });

  const dist = processing && processing.distance;
  const totalMeasured = used.length ? used[used.length - 1].d || 0 : 0;
  const totalGap = used.length ? used[used.length - 1].g || 0 : 0;
  stops.forEach((s) => { delete s._leftCum; });
  return {
    rideId: ride.id,
    startTs: rideStart,
    endTs: active ? null : rideEnd,
    active,
    totals: {
      measuredM: totalMeasured,
      gapEstimateM: totalGap,
      businessM: dist ? dist.metres.verifiedBusiness + dist.metres.likelyBusiness : null,
      verifiedBusinessM: dist ? dist.metres.verifiedBusiness : null,
      unknownM: dist ? dist.metres.unknown : null,
      personalM: dist ? dist.metres.personal : null,
      stops: stops.length,
      restaurantStops: stops.filter((s) => s.category === CATEGORY.RESTAURANT).length,
      restaurantsVisited: new Set(stops.filter((s) => s.category === CATEGORY.RESTAURANT).map((s) => s.placeId)).size,
      unknownStops: stops.filter((s) => s.category === CATEGORY.UNKNOWN).length,
      depotStops: stops.filter((s) => s.category === CATEGORY.MODERN_DAIRY).length,
      missedDeliveries: shortVisits.length + stops.filter((s) => s.category === CATEGORY.MISSED).length,
      notInPlan: notInPlan.length,
      timeAtStopsSec: stops.reduce((a, s) => a + s.durationSec, 0),
      fixes: points.length,
      fixesExcluded: points.filter((p) => !p.used).length,
    },
    stops,
    segments,
    events,
    shortVisits,
    notInPlan,
  };
}

module.exports = { buildJourney, CATEGORY, CATEGORY_LABEL, categoryOf };
