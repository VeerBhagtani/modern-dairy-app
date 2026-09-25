/* Answering "I am going to these three restaurants — in what order?"
 *
 * Everything difficult about this lives in two pure modules: legCost decides
 * what a leg costs for this particular driver, tour decides the order and when
 * to keep quiet about it. This file is the plumbing between them and the
 * database, and the one place that decides whether to spend money.
 *
 * The spending rule, in one sentence: ask Google only about legs that neither
 * this driver nor anybody else in the fleet has ever driven.
 */
'use strict';

const repo = require('./repo');
const legCost = require('../drivers/legCost');
const tour = require('../drivers/tour');
const routeMatrix = require('./routeMatrix');
const { stopEligibility, INELIGIBLE } = require('../drivers/eligibility');
const { getSecret } = require('./secretManager');

/* Plan one trip.
 *
 * @param driverId
 * @param start     { id, lat, lng } — where the driver is now, or the depot
 * @param stopIds   the restaurants they intend to visit
 * @param returnTo  optional stop id to finish at
 */
async function planTrip(driverId, { start, stopIds, returnTo = null, useRoadApi = true }) {
  const { restaurants, facilities } = await repo.loadPlaces();
  const byId = new Map([...restaurants, ...facilities].map((p) => [p.id, p]));

  // Two reasons a stop cannot go into a round, kept apart because they need
  // different things said about them. No location is our problem to fix; on
  // hold is a decision the office has already made, and the driver needs to be
  // told which restaurant and why rather than watching it vanish.
  const stops = [];
  const unplaceable = [];
  const onHold = [];
  for (const id of stopIds) {
    const p = byId.get(id);
    const verdict = stopEligibility(p);
    if (verdict.ok) {
      stops.push({ id: p.id, name: p.name, lat: p.lat, lng: p.lng });
    } else if (verdict.reason === INELIGIBLE.ON_HOLD) {
      onHold.push({ id, name: p.name, reason: p.holdReason || null });
    } else {
      unplaceable.push(id);
    }
  }
  if (stops.length < 2) {
    return {
      error: onHold.length
        ? 'Supply is on hold for ' + onHold.map((h) => h.name).join(', ')
          + ', so there are not enough stops left to plan a round.'
        : 'At least two stops with confirmed locations are needed to plan a route.',
      unplaceable,
      onHold,
    };
  }

  const all = [{ id: start.id, name: start.name || 'Start', lat: start.lat, lng: start.lng }, ...stops];

  const [own, fleet] = await Promise.all([repo.loadDriverLegs(driverId), repo.loadFleetLegs()]);

  // First pass: what do we already know, and what is genuinely unknown?
  const first = legCost.buildCostTable(all, { learned: own.legs, fleetPrior: fleet });

  // Second pass: buy only the unknown legs, if there are any and we are allowed.
  let apiPrior = {};
  let roadApi = { asked: 0, answered: 0, error: null };
  if (useRoadApi && first.unknown.length) {
    const byStopId = new Map(all.map((s) => [s.id, s]));
    const legs = first.unknown.map((u) => ({ from: byStopId.get(u.from), to: byStopId.get(u.to) }));
    try {
      const apiKey = await getSecret('geocoding');
      if (apiKey) {
        roadApi.asked = legs.length;
        apiPrior = await routeMatrix.cachedFetchLegs(legs, apiKey, { cache: repo.routeCache, departureTime: Date.now() });
        roadApi.answered = Object.keys(apiPrior).length;
        roadApi.cached = apiPrior.stats ? apiPrior.stats.hits : 0;
      }
    } catch (e) {
      // A plan built on straight lines is worse than one built on roads, but
      // it is far better than no plan. Say so and carry on.
      roadApi.error = e.notEnabled
        ? 'The lookup key cannot use the Routes API yet, so distances are estimated.'
        : e.message;
    }
  }

  const { table } = legCost.buildCostTable(all, { learned: own.legs, fleetPrior: fleet, apiPrior });

  const best = tour.optimise(start.id, stops.map((s) => s.id), table, { returnTo });
  if (!best) return { error: 'No route could be costed between these stops.', unplaceable };

  const habit = tour.habitualOrder(own.sequences.map((s) => s.order), stops.map((s) => s.id));
  const chosen = tour.preferHabit(best, habit, table, { startId: start.id, returnTo });

  const name = (id) => (byId.get(id) || {}).name || (id === start.id ? (start.name || 'Start') : id);
  const legs = [];
  for (let i = 0; i < chosen.order.length - 1; i += 1) {
    const key = legCost.legKey(chosen.order[i], chosen.order[i + 1]);
    const leg = table[key];
    legs.push({
      from: chosen.order[i], fromName: name(chosen.order[i]),
      to: chosen.order[i + 1], toName: name(chosen.order[i + 1]),
      distanceM: Math.round(leg.distanceM),
      durationS: Math.round(leg.durationS),
      // How this number was arrived at, so the driver can see when the app is
      // repeating their own experience back to them and when it is guessing.
      basis: leg.source,
      runs: leg.runs || 0,
    });
  }

  return {
    order: chosen.order,
    stops: chosen.order.map((id) => ({ id, name: name(id) })),
    legs,
    totalDistanceM: Math.round(chosen.cost.distanceM),
    totalDurationS: Math.round(chosen.cost.durationS),
    followed: chosen.followed,
    reason: chosen.reason,
    alternative: chosen.alternative || null,
    savingM: chosen.savingM ? Math.round(chosen.savingM) : 0,
    habitRuns: habit ? habit.times : 0,
    learnedLegs: legs.filter((l) => l.runs > 0).length,
    unplaceable,
    onHold,
    roadApi,
  };
}

module.exports = { planTrip };
