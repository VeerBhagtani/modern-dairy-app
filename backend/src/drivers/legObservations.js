/* Turning rides that already happened into knowledge about roads.
 *
 * Every processed ride already records, for each restaurant the driver
 * visited: which place it was, when they arrived, when they left, and how far
 * they travelled to get there. Two consecutive visits therefore describe one
 * leg completely — where from, where to, how far, how long — without asking
 * anybody anything or calling any API.
 *
 * That is the whole trick behind per-driver routing. The system never learns
 * that a driver turns left at the temple; it learns that this driver covers
 * that leg in 1.9 km where the map says 2.6, and plans accordingly. The turn
 * is the driver's business. The distance is the company's.
 *
 * What this file mostly does is refuse observations. A leg measured across a
 * GPS gap is a leg that was partly guessed, and feeding guesses back in as
 * evidence would let one bad afternoon quietly teach the system a shortcut
 * that does not exist.
 */

// A leg whose measured distance is this much guesswork is not evidence.
// Approach distance already reports its own gap estimate, so this is a
// straight read of how much of the number was actually observed.
const MAX_GAP_FRACTION = 0.1;

// Sanity bounds. A "leg" covered in four seconds is two stops detected at one
// restaurant; one that took six hours had a lunch break, a breakdown or the
// end of a shift in the middle of it, and is not how long the road takes.
const MIN_DURATION_S = 30;
const MAX_DURATION_S = 3 * 3600;
const MIN_DISTANCE_M = 50;

// Faster than this over a whole leg means the GPS wandered or the clock did.
const MAX_SPEED_KMH = 120;

/* Why an observation was rejected — returned rather than logged, so the
 * dashboard can say "we learned 3 of your 5 legs, and here is why". */
const REJECT = {
  NO_PLACE: 'a stop that was not matched to a restaurant',
  SAME_PLACE: 'two stops at the same restaurant',
  GAPPY: 'too much of the distance was estimated across a GPS gap',
  TOO_SHORT: 'too short to be a journey',
  TOO_LONG: 'too long to be one journey',
  IMPOSSIBLE: 'implausibly fast',
};

/* One ride's visits become the legs between them.
 *
 * @param visits  as produced by distancePerVisit(): ordered by time, each with
 *                placeId, arrivedAt, departedAt, approachDistanceM and
 *                approachGapEstimateM.
 * @returns { observations, rejected, sequence }
 *          sequence is the order of restaurants actually visited, which is
 *          what the habit rule reads.
 */
function legsFromVisits(visits, { at = null } = {}) {
  const list = (visits || []).filter((v) => v && v.placeId);
  const observations = [];
  const rejected = [];
  const sequence = list.map((v) => v.placeId);

  for (let i = 0; i < list.length - 1; i += 1) {
    const from = list[i];
    const to = list[i + 1];
    const note = (reason) => rejected.push({ from: from.placeId, to: to.placeId, reason });

    if (from.placeId === to.placeId) { note(REJECT.SAME_PLACE); continue; }

    const distanceM = Number(to.approachDistanceM);
    const gapM = Number(to.approachGapEstimateM) || 0;
    const durationS = (Number(to.arrivedAt) - Number(from.departedAt)) / 1000;

    if (!Number.isFinite(distanceM) || distanceM < MIN_DISTANCE_M) { note(REJECT.TOO_SHORT); continue; }
    if (!Number.isFinite(durationS) || durationS < MIN_DURATION_S) { note(REJECT.TOO_SHORT); continue; }
    if (durationS > MAX_DURATION_S) { note(REJECT.TOO_LONG); continue; }

    // The measured distance has to be mostly measured. This is the check that
    // keeps a drive through a tunnel from teaching the system a shortcut.
    if (gapM > 0 && gapM / (distanceM + gapM) > MAX_GAP_FRACTION) { note(REJECT.GAPPY); continue; }

    const kmh = (distanceM / 1000) / (durationS / 3600);
    if (kmh > MAX_SPEED_KMH) { note(REJECT.IMPOSSIBLE); continue; }

    observations.push({
      from: from.placeId,
      to: to.placeId,
      distanceM: Math.round(distanceM),
      durationS: Math.round(durationS),
      at: at || Number(to.arrivedAt) || null,
    });
  }

  return { observations, rejected, sequence };
}

/* Fold many rides' observations into the shape legCost.buildCostTable wants:
 * { 'from>to': [observation, ...] }. Kept separate from the extraction so a
 * single ride can be folded in as it finishes, or a year re-read at once. */
function groupByLeg(observations) {
  const out = {};
  for (const o of observations || []) {
    const key = `${o.from}>${o.to}`;
    (out[key] = out[key] || []).push({ distanceM: o.distanceM, durationS: o.durationS, at: o.at });
  }
  return out;
}

module.exports = {
  MAX_GAP_FRACTION, MIN_DURATION_S, MAX_DURATION_S, MIN_DISTANCE_M, MAX_SPEED_KMH,
  REJECT, legsFromVisits, groupByLeg,
};
