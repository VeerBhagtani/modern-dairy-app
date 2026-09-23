/* Putting a driver's stops in the best order.
 *
 * With three restaurants there are six possible orders, with four there are
 * twenty-four. At those sizes the right algorithm is to try all of them and
 * keep the cheapest — exact, obvious, and impossible to get subtly wrong.
 * Beyond eight stops the count stops being sane, so a nearest-neighbour route
 * improved by 2-opt takes over: not provably optimal, but within a few percent
 * and finished in milliseconds.
 *
 * The genuinely important part of this file is not the search. It is
 * preferHabit() at the bottom.
 *
 * A driver who has run the same three restaurants forty times has a reason for
 * the order they use, and it is usually a reason this system cannot see: a
 * delivery window, a shop that opens late, a road that is fine at six and
 * impossible at nine. If the optimiser's order is barely better — a few
 * hundred metres over a whole morning — telling the driver to change is not an
 * optimisation, it is noise dressed up as advice, and after the third time
 * nobody reads the screen any more.
 *
 * So the rule is: the driver's own habitual order wins unless the alternative
 * is meaningfully better. Pure, so the threshold is a number in a config file
 * and not an opinion buried in a controller.
 */

const { legKey } = require('./legCost');

// How much better an alternative must be before it is worth telling a driver
// to change what they already do. Both must be cleared: a shorter route that
// saves eighty metres is not a shorter route.
const HABIT_MARGIN_FRACTION = 0.05;   // 5% of the trip
const HABIT_MARGIN_M = 500;           // and at least half a kilometre

// Above this many stops, stop enumerating: 9! is 362,880 tours, each of which
// costs nine table lookups, and a driver does not have nine stops anyway.
const BRUTE_FORCE_LIMIT = 8;

/* What one order costs, start to finish. `order` is a list of stop ids; the
 * depot, if there is one, is already the first element.
 *
 * Returns null when any leg is missing from the table rather than silently
 * scoring an impossible route as free.
 */
function tourCost(order, table) {
  let distanceM = 0;
  let durationS = 0;
  for (let i = 0; i < order.length - 1; i += 1) {
    const leg = table[legKey(order[i], order[i + 1])];
    if (!leg) return null;
    distanceM += leg.distanceM;
    durationS += leg.durationS;
  }
  return { distanceM, durationS };
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

/* Every order, scored. Only for small stop counts — the caller checks. */
function bestByEnumeration(startId, stopIds, table, returnTo) {
  let best = null;
  for (const perm of permutations(stopIds)) {
    const order = [startId, ...perm];
    if (returnTo) order.push(returnTo);
    const cost = tourCost(order, table);
    if (!cost) continue;
    if (!best || cost.distanceM < best.cost.distanceM) best = { order, cost };
  }
  return best;
}

/* Nearest neighbour, then 2-opt until it stops improving. Used only above
 * BRUTE_FORCE_LIMIT stops. */
function bestByHeuristic(startId, stopIds, table, returnTo) {
  const remaining = new Set(stopIds);
  let current = startId;
  const order = [startId];
  while (remaining.size) {
    let pick = null; let pickCost = Infinity;
    for (const id of remaining) {
      const leg = table[legKey(current, id)];
      if (leg && leg.distanceM < pickCost) { pick = id; pickCost = leg.distanceM; }
    }
    if (!pick) break;
    order.push(pick);
    remaining.delete(pick);
    current = pick;
  }
  if (returnTo) order.push(returnTo);

  // 2-opt: reverse each interior span and keep the reversal if it is shorter.
  // The endpoints are fixed — the driver starts where they are.
  const last = returnTo ? order.length - 1 : order.length;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < last - 1; i += 1) {
      for (let j = i + 1; j < last; j += 1) {
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, j + 1).reverse(),
          ...order.slice(j + 1),
        ];
        const a = tourCost(order, table);
        const b = tourCost(candidate, table);
        if (a && b && b.distanceM < a.distanceM) {
          order.splice(0, order.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  const cost = tourCost(order, table);
  return cost ? { order, cost } : null;
}

/* The cheapest order to visit every stop, starting from where the driver is.
 *
 * @param startId   where the driver is now (or the depot)
 * @param stopIds   the restaurants, in no particular order
 * @param table     from buildCostTable
 * @param returnTo  optional id to finish at — the depot, for a driver who has
 *                  to bring the vehicle back. It changes the answer, so it is
 *                  explicit rather than assumed either way.
 */
function optimise(startId, stopIds, table, { returnTo = null } = {}) {
  const ids = stopIds.filter((id) => id !== startId);
  if (!ids.length) return null;
  return ids.length <= BRUTE_FORCE_LIMIT
    ? bestByEnumeration(startId, ids, table, returnTo)
    : bestByHeuristic(startId, ids, table, returnTo);
}

/* Does the driver already do this run, and in what order?
 *
 * `history` is a list of past visit sequences by this driver, each a list of
 * stop ids. A sequence counts only if it covers exactly the stops being
 * planned — a day they also went somewhere else says nothing about this trip.
 */
function habitualOrder(history, stopIds) {
  const wanted = [...stopIds].sort().join('|');
  const tally = new Map();
  for (const seq of history || []) {
    if ([...seq].sort().join('|') !== wanted) continue;
    const k = seq.join('>');
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  if (!tally.size) return null;
  let bestKey = null; let bestN = 0;
  for (const [k, n] of tally) if (n > bestN) { bestKey = k; bestN = n; }
  return { order: bestKey.split('>'), times: bestN };
}

/* The rule that keeps this feature usable.
 *
 * Given the optimiser's answer and what the driver actually does, decide which
 * to show. The driver's own order wins unless the optimiser saves both a
 * worthwhile fraction of the trip AND a worthwhile absolute distance — because
 * five percent of two kilometres is not worth a instruction, and five hundred
 * metres off a fifty-kilometre day is not either.
 */
function preferHabit(best, habit, table, {
  marginFraction = HABIT_MARGIN_FRACTION,
  marginM = HABIT_MARGIN_M,
  startId = null,
  returnTo = null,
} = {}) {
  if (!habit) return { ...best, followed: 'optimiser', reason: 'no habit recorded yet' };

  const habitFull = startId ? [startId, ...habit.order.filter((id) => id !== startId)] : [...habit.order];
  if (returnTo) habitFull.push(returnTo);
  const habitCost = tourCost(habitFull, table);
  if (!habitCost) return { ...best, followed: 'optimiser', reason: 'the usual order could not be costed' };

  const saving = habitCost.distanceM - best.cost.distanceM;
  const worthwhile = saving > marginM && saving > habitCost.distanceM * marginFraction;

  if (!worthwhile) {
    return {
      order: habitFull,
      cost: habitCost,
      followed: 'driver',
      alternative: { order: best.order, cost: best.cost, savingM: Math.max(0, saving) },
      reason: saving <= 0
        ? 'the driver\'s usual order is already the shortest'
        : 'the difference is too small to be worth changing a routine',
    };
  }
  return {
    ...best,
    followed: 'optimiser',
    habit: { order: habitFull, cost: habitCost, times: habit.times },
    savingM: saving,
    reason: 'meaningfully shorter than the usual order',
  };
}

module.exports = {
  HABIT_MARGIN_FRACTION, HABIT_MARGIN_M, BRUTE_FORCE_LIMIT,
  tourCost, permutations, optimise, habitualOrder, preferHabit,
};
