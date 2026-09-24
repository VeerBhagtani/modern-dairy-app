/* A driver's history: one row per day.
 *
 * Shared by the office's History tab and the driver's own history on the
 * phone, so both see the same days with the same numbers. Rides are one per
 * day (repo.closeIfDayOver), so a ride is a day.
 *
 * Rides that are out of date are calculated first, within a budget, so
 * opening a history shows real kilometres rather than "not calculated".
 */
'use strict';

const repo = require('./repo');
const { bringUpToDate, housekeeping } = require('./rideProcessing');

const round1 = (m) => Math.round((m || 0) / 100) / 10;

function dayRow(ride, result) {
  const row = {
    rideId: ride.id,
    dayKey: ride.dayKey,
    status: ride.status,
    stopKind: ride.stopKind || null,
    startedAt: ride.startedAt || null,
    stoppedAt: ride.stoppedAt || null,
    pointCount: ride.pointCount || 0,
    calculated: !!result,
    km: null,
    restaurants: [],
  };
  if (!result) return row;
  const m = result.distance.metres;
  // Exact metres, kept for adding days together; kilometres are for reading.
  row.metres = {
    business: m.verifiedBusiness + m.likelyBusiness,
    verifiedBusiness: m.verifiedBusiness,
    likelyBusiness: m.likelyBusiness,
    personal: m.personal,
    unknown: m.unknown,
    gapEstimate: m.gapEstimate,
    total: m.dayTotal,
  };
  row.km = {
    // Business, as one figure for a driver to read, and its two parts for the
    // office: verified (backed by an order or the depot) and likely.
    business: round1(m.verifiedBusiness + m.likelyBusiness),
    verifiedBusiness: round1(m.verifiedBusiness),
    likelyBusiness: round1(m.likelyBusiness),
    personal: round1(m.personal),
    unknown: round1(m.unknown),
    gapEstimate: round1(m.gapEstimate),
    total: round1(m.dayTotal),
  };
  // The restaurants reached that day, in order, once each.
  const seen = new Set();
  for (const v of result.visits || []) {
    const key = v.placeId || v.placeName;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    row.restaurants.push({ name: v.placeName || 'Restaurant', arrivedAt: v.arrivedAt || null });
  }
  row.reviewPending = result.review ? result.review.pending : 0;
  return row;
}

/* @param driverId   whose history (from the token on the phone, from the
 *                   request for the office — never both)
 * @param from, to   epoch ms, inclusive; ride start time
 * @returns { days: [...newest first], totals, calculation }
 */
async function driverHistory({ driverId, from, to, maxRides = 62, calcBudget = {} }) {
  await housekeeping();
  let rides = await repo.listRides({ driverId, from, to, limit: maxRides });
  const calculation = await bringUpToDate(rides, { maxRides: 12, budgetMs: 10000, ...calcBudget });
  if (calculation.calculated.length) rides = await repo.listRides({ driverId, from, to, limit: maxRides });

  const days = await Promise.all(rides.map(async (ride) => dayRow(ride, await repo.loadProcessing(ride.id, { withSegments: false }))));
  days.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  // Summed in metres and rounded once: adding a month of days already rounded
  // to 0.1 km would drift by up to a kilometre and a half.
  const KEYS = ['business', 'verifiedBusiness', 'likelyBusiness', 'personal', 'unknown', 'gapEstimate', 'total'];
  const sumM = Object.fromEntries(KEYS.map((k) => [k, 0]));
  let calculatedDays = 0;
  for (const d of days) {
    if (!d.metres) continue;
    calculatedDays += 1;
    for (const k of KEYS) sumM[k] += d.metres[k];
  }
  const totals = { days: days.length, calculatedDays, ...Object.fromEntries(KEYS.map((k) => [k, round1(sumM[k])])) };
  for (const d of days) delete d.metres;
  return {
    days,
    totals,
    calculation: { calculated: calculation.calculated.length, deferred: calculation.deferred },
  };
}

module.exports = { driverHistory, dayRow };
