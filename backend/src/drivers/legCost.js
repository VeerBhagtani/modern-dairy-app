/* What it actually costs this driver to get from A to B.
 *
 * The obvious way to order a driver's stops is to ask Google how far apart
 * they are. That answer is the same for all forty drivers, and it is wrong for
 * most of them. Drivers know shortcuts. They know which turn is impossible at
 * eight in the morning. They know the gate at the back of the estate. The
 * office does not, Google does not, and neither does this file — but the GPS
 * traces already recorded do, because a driver who takes a shortcut simply
 * arrives sooner, having covered less ground.
 *
 * So a leg's cost is learned from that driver's own history where there is
 * any, and borrowed from a prior — the fleet's experience, or Google, or the
 * straight line — only where there is not. Nothing here needs to know a road
 * name or a turn. The driver's route choice shows up as a smaller number.
 *
 * Everything in this file is pure. It takes observations and returns costs.
 */

const { haversineM } = require('./geo');

// How many of this driver's own runs before their number is trusted outright.
// Below it, their number is blended with the prior in proportion — one run is
// weak evidence, five is not, and there is no cliff between them.
const FULL_TRUST_RUNS = 5;

// Road distance is always longer than the straight line. Pune's grid, measured
// against real trips, sits near 1.4; it is only ever used where nothing better
// is known, and any learned observation replaces it.
const DETOUR_FACTOR = 1.4;

// A leg nobody has driven in this long is stale: roads change, and so do the
// hours a driver works. Kept generous — a restaurant visited monthly is still
// a restaurant.
const MAX_AGE_MS = 180 * 24 * 3600 * 1000;

/* A leg is a direction: A→B is not B→A. One-ways, and the fact that the hill
 * is only a hill one way round, make that a real distinction. */
function legKey(fromId, toId) {
  return `${fromId}>${toId}`;
}

/* The median, not the mean.
 *
 * One run where the driver stopped for lunch on the way should not move the
 * estimate at all, and with a mean it would move it a lot. The median simply
 * ignores it, which is the correct treatment of a trip that was not really
 * this leg.
 */
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* Fold a driver's observations of one leg into a single distance and duration.
 *
 * Observations are {distanceM, durationS, at}. Anything older than MAX_AGE_MS
 * is dropped rather than averaged in.
 */
function summarise(observations, now = Date.now()) {
  const fresh = (observations || []).filter(
    (o) => Number.isFinite(o.distanceM) && Number.isFinite(o.durationS)
      && o.distanceM > 0 && o.durationS > 0
      && (!o.at || now - o.at <= MAX_AGE_MS),
  );
  if (!fresh.length) return null;
  return {
    runs: fresh.length,
    distanceM: median(fresh.map((o) => o.distanceM)),
    durationS: median(fresh.map((o) => o.durationS)),
    lastAt: Math.max(...fresh.map((o) => o.at || 0)) || null,
  };
}

/* The straight line, inflated. The weakest prior there is, and the only one
 * that is always available. */
function straightLinePrior(from, to) {
  const m = haversineM(from, to) * DETOUR_FACTOR;
  return {
    distanceM: m,
    // 18 km/h average through Pune traffic, including the lights. This is a
    // placeholder that any real observation displaces immediately.
    durationS: (m / 1000) * (3600 / 18),
    source: 'straight-line',
  };
}

/* Blend what this driver has done with whatever prior is available.
 *
 * With no runs, the prior stands. With FULL_TRUST_RUNS or more, the driver's
 * own median stands. In between the two are mixed in proportion, so the
 * estimate moves towards the truth as evidence arrives instead of flipping on
 * the strength of a single trip.
 */
function blend(own, prior) {
  if (!own) return { ...prior, runs: 0, confidence: 'prior' };
  if (!prior) return { ...own, source: 'driver', confidence: 'driver' };

  const w = Math.min(1, own.runs / FULL_TRUST_RUNS);
  const mix = (a, b) => a * w + b * (1 - w);
  return {
    distanceM: mix(own.distanceM, prior.distanceM),
    durationS: mix(own.durationS, prior.durationS),
    runs: own.runs,
    source: w >= 1 ? 'driver' : 'driver+prior',
    confidence: w >= 1 ? 'driver' : (w > 0 ? 'learning' : 'prior'),
  };
}

/* Build the full cost table for one driver over a set of stops.
 *
 * @param stops       [{ id, lat, lng }]
 * @param learned     { 'a>b': [observation, ...] } for THIS driver
 * @param fleetPrior  { 'a>b': { distanceM, durationS } } seen across all drivers
 * @param apiPrior    { 'a>b': { distanceM, durationS } } from a road-network API
 *
 * The order of preference for a leg nobody in this cab has driven is:
 * the road API if it was asked, else the rest of the fleet, else the straight
 * line. The driver's own history always wins where it exists.
 */
function buildCostTable(stops, { learned = {}, fleetPrior = {}, apiPrior = {}, now = Date.now() } = {}) {
  const byId = new Map(stops.map((s) => [s.id, s]));
  const table = {};
  const unknown = [];

  for (const a of stops) {
    for (const b of stops) {
      if (a.id === b.id) continue;
      const key = legKey(a.id, b.id);
      const own = summarise(learned[key], now);
      const prior = apiPrior[key]
        ? { ...apiPrior[key], source: 'road-api' }
        : (fleetPrior[key]
          ? { ...fleetPrior[key], source: 'fleet' }
          : straightLinePrior(byId.get(a.id), byId.get(b.id)));

      table[key] = blend(own, prior);
      // Worth asking a road API about: nobody has driven it and nothing but
      // the straight line is known. This is what keeps the API bill small.
      if (!own && prior.source === 'straight-line') unknown.push({ from: a.id, to: b.id });
    }
  }
  return { table, unknown };
}

module.exports = {
  FULL_TRUST_RUNS, DETOUR_FACTOR, MAX_AGE_MS,
  legKey, median, summarise, straightLinePrior, blend, buildCostTable,
};
