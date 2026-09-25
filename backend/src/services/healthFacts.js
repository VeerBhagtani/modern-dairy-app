/* What is actually wrong with this system right now.
 *
 * This gathers the numbers a maintainer would go looking for if they sat down
 * to audit the platform: data that is not flowing, work that is queued and not
 * being done, evidence that is missing, thresholds that have been moved, rides
 * whose arithmetic does not add up.
 *
 * Two rules govern what goes in here, and both matter:
 *
 *  1. FACTS ONLY. This file counts and measures. It does not decide what is
 *     important, does not rank, and does not recommend — that is the language
 *     model's job in maintenance.js. Keeping the measuring separate from the
 *     judging means the numbers can be checked by a person, and a wrong
 *     conclusion can never be blamed on a wrong count.
 *
 *  2. NO PERSONAL DATA LEAVES. This output is sent to Anthropic's API. So it
 *     carries no coordinates, no driver names, no customer names, no
 *     addresses, no ride identifiers. Counts, ages and aggregates only. An
 *     audit is worth having; it is not worth shipping the fleet's movements to
 *     a third party to get it. Everything here is deliberately shaped so that
 *     reading it tells you the system's state and nothing about any person.
 */
'use strict';

const repo = require('./repo');
const { resolveConfig, DEFAULTS } = require('../drivers/config');
const { depotCheck } = require('./depotCheck');

const DAY = 24 * 3600 * 1000;

/* Count without downloading. select() with no fields fetches document stubs,
 * which is what makes it reasonable to ask a dozen of these questions. */
async function countOf(query) {
  const snap = await query.select().get();
  return snap.size;
}

async function gather({ now = Date.now() } = {}) {
  const since7 = now - 7 * DAY;
  const since30 = now - 30 * DAY;

  const [
    { config, overrides }, drivers, rides7, alerts, restaurantSnap, facilitySnap, lockState,
  ] = await Promise.all([
    repo.getConfig({ fresh: true }),
    repo.listDrivers({ includeInactive: true }),
    repo.listRides({ from: since7, limit: 500 }),
    repo.openAlerts(),
    repo.C.restaurants().get(),
    repo.C.facilities().get(),
    repo.getLocationsLock(),
  ]);

  const restaurants = restaurantSnap.docs.map((d) => d.data());
  const hasPin = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng);

  // ── the restaurant list ────────────────────────────────────────────────
  const locations = {
    total: restaurants.length,
    onMap: restaurants.filter(hasPin).length,
    noLocation: restaurants.filter((p) => !hasPin(p)).length,
    supplyOnHold: restaurants.filter((p) => p.supplyHold === true).length,
    // Rows placed by a route that traded precision for coverage. Worth
    // surfacing: they are correct often enough to be useful and wrong often
    // enough that nobody should forget they exist.
    placedUnderDifferentName: restaurants.filter((p) => p.locationSource === 'places_name_differs').length,
    placedAtAreaCentre: restaurants.filter((p) => p.locationSource === 'accepted_in_bulk_AREA_ONLY').length,
    placedByHand: restaurants.filter((p) => p.locationSource === 'office' || p.confirmedBy).length,
    facilities: facilitySnap.size,
    listLocked: lockState.locked,
  };
  // Counts and a distance only — no coordinates leave (rule 2).
  const depot = depotCheck(facilitySnap.docs.map((d) => d.data()));

  // ── are drivers actually using it ──────────────────────────────────────
  const activeDrivers = drivers.filter((d) => d.status === 'active');
  const drivenLast7 = new Set(rides7.map((r) => r.driverId));
  const fleet = {
    registered: drivers.length,
    active: activeDrivers.length,
    withARideInLast7Days: drivenLast7.size,
    // A driver who registered and never drove is usually an install that did
    // not survive first contact — a permissions prompt refused, or an app
    // nobody explained.
    neverDriven: null,   // filled in below: drivers have no lastRideAt field
    ridesLast7Days: rides7.length,
    ridesStillOpen: rides7.filter((r) => r.status === 'active').length,
    ridesAutoClosed: rides7.filter((r) => r.status === 'auto_closed').length,
  };

  // A driver who has never driven has no ride at all. One small query each:
  // the fleet is about forty.
  const hasRide = await Promise.all(activeDrivers.map((d) => repo.C.rides().where('driverId', '==', d.id).limit(1).select().get()
    .then((s) => !s.empty).catch(() => true)));
  fleet.neverDriven = hasRide.filter((x) => !x).length;

  // ── is the calculation keeping up, and does it reconcile ───────────────
  const finished = rides7.filter((r) => r.status !== 'active');
  const results = await Promise.all(
    finished.slice(0, 200).map((r) => repo.loadProcessing(r.id, { withSegments: false }).catch(() => null)),
  );
  const done = results.filter(Boolean);

  let verified = 0; let likely = 0; let personal = 0; let unknown = 0; let invalid = 0;
  let gapEstimate = 0; let dayTotal = 0; let residualWorst = 0; let needsReview = 0;
  for (const r of done) {
    const m = r.distance.metres;
    verified += m.verifiedBusiness; likely += m.likelyBusiness; personal += m.personal;
    unknown += m.unknown; invalid += m.invalid || 0;
    gapEstimate += m.gapEstimate || 0; dayTotal += m.dayTotal;
    // The pipeline asserts its own identities and reports the residual rather
    // than rounding it away. A residual that is not ~0 is a real bug.
    // (distance.residualM and counts.pendingReview never existed: the audit
    // read zero for both, and a broken reconciliation looked perfect.)
    const rec = r.distance.reconciliation || {};
    const res = Math.max(Math.abs(rec.bucketResidualM || 0), Math.abs(rec.totalResidualM || 0));
    if (res > residualWorst) residualWorst = res;
    needsReview += (r.review && r.review.pending) || 0;
  }

  const pct = (part) => (dayTotal > 0 ? Math.round((part / dayTotal) * 1000) / 10 : null);
  const calculation = {
    ridesFinishedLast7Days: finished.length,
    ridesCalculated: done.length,
    ridesNotCalculated: finished.length - done.length,
    kmDayTotal: Math.round(dayTotal / 100) / 10,
    percentVerifiedBusiness: pct(verified),
    percentLikelyBusiness: pct(likely),
    percentPersonal: pct(personal),
    percentUnknown: pct(unknown),
    percentInvalid: pct(invalid),
    percentEstimatedAcrossGaps: pct(gapEstimate),
    worstReconciliationResidualMetres: Math.round(residualWorst),
    segmentsAwaitingReview: needsReview,
  };

  // ── evidence ───────────────────────────────────────────────────────────
  const [orders30, matches30] = await Promise.all([
    countOf(repo.C.orders().where('orderedAt', '>=', since30)),
    // Matches carry visitAt; there is no `at` on them.
    countOf(repo.C.matches().where('visitAt', '>=', since30)).catch(() => 0),
  ]);
  const evidence = {
    orderRecordsLast30Days: orders30,
    deliveryMatchesLast30Days: matches30,
    // Without orders, a visit can never be raised above "likely". This is the
    // single biggest determinant of whether the verified figure means anything.
    ordersConfigured: orders30 > 0,
  };

  // ── what the system is complaining about ───────────────────────────────
  const byKind = {};
  for (const a of alerts) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  const oldestAlertAgeDays = alerts.length
    ? Math.round((now - Math.min(...alerts.map((a) => a.raisedAt))) / DAY)
    : 0;

  // ── settings that have been moved off their defaults ───────────────────
  const resolved = resolveConfig(overrides || {});
  const changedSettings = Object.keys(overrides || {})
    .filter((k) => k !== 'retention' && overrides[k] !== DEFAULTS[k])
    .map((k) => ({ setting: k, now: config[k], default: DEFAULTS[k] }));

  // ── learned routing ────────────────────────────────────────────────────
  let routing = { driversWithLearnedRoads: 0, legsLearned: 0 };
  try {
    const legsSnap = await repo.C.drivers().firestore.collection('driver_legs').get();
    let legs = 0;
    for (const d of legsSnap.docs) legs += Object.keys(d.data().legs || {}).length;
    routing = { driversWithLearnedRoads: legsSnap.size, legsLearned: legs };
  } catch (e) { /* the collection may not exist yet, which is itself fine */ }

  return {
    generatedAt: now,
    locations,
    depot,
    fleet,
    calculation,
    evidence,
    alerts: { open: alerts.length, byKind, oldestOpenAgeDays: oldestAlertAgeDays },
    settings: {
      changedFromDefault: changedSettings,
      rejectedOverrides: resolved.rejected || [],
      retentionDays: config.retention,
    },
    routing,
  };
}

module.exports = { gather };
