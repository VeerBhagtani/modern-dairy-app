// Ordering a driver's stops, and knowing when to keep quiet about it.
//
// Two things are being protected here. The first is arithmetic: with three or
// four stops the answer is exactly knowable, so "roughly right" is not good
// enough. The second matters more — the rule that stops this feature nagging.
// A driver told to change their routine to save eighty metres stops reading
// the screen, and then the feature is worth less than nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
const tour = require_(path.join(ROOT, 'backend/src/drivers/tour.js'));
const legCost = require_(path.join(ROOT, 'backend/src/drivers/legCost.js'));

// A cost table built by hand, so the right answer is known independently of
// any code in the module under test.
function tableOf(pairs) {
  const t = {};
  for (const [from, to, distanceM, durationS] of pairs) {
    t[legCost.legKey(from, to)] = { distanceM, durationS: durationS ?? distanceM / 5 };
  }
  return t;
}

// Depot D, restaurants A, B, C strung out along one road:  D—A—B—C
// so D,A,B,C is obviously shortest and D,C,A,B obviously is not.
const LINE = tableOf([
  ['D', 'A', 1000], ['A', 'D', 1000],
  ['D', 'B', 2000], ['B', 'D', 2000],
  ['D', 'C', 3000], ['C', 'D', 3000],
  ['A', 'B', 1000], ['B', 'A', 1000],
  ['A', 'C', 2000], ['C', 'A', 2000],
  ['B', 'C', 1000], ['C', 'B', 1000],
]);

test('three stops are ordered exactly, not approximately', () => {
  const best = tour.optimise('D', ['C', 'A', 'B'], LINE);
  assert.deepEqual(best.order, ['D', 'A', 'B', 'C']);
  assert.equal(best.cost.distanceM, 3000);
});

test('every one of the six orders really is considered', () => {
  // If the search quietly kept the input order this would pass by luck, so the
  // stops are handed over in the worst possible order.
  const best = tour.optimise('D', ['C', 'B', 'A'], LINE);
  assert.deepEqual(best.order, ['D', 'A', 'B', 'C']);
  assert.equal(tour.permutations(['a', 'b', 'c']).length, 6);
});

test('coming back to the depot changes the answer, so it is asked for explicitly', () => {
  const oneWay = tour.optimise('D', ['A', 'B', 'C'], LINE);
  const round = tour.optimise('D', ['A', 'B', 'C'], LINE, { returnTo: 'D' });
  assert.equal(oneWay.cost.distanceM, 3000);
  assert.equal(round.cost.distanceM, 6000, 'the return leg must be counted');
});

test('a one-way street is not the same leg backwards', () => {
  // A→B is cheap, B→A is a long way round. The order must follow the cheap
  // direction even though a symmetric table would call them equal.
  const t = tableOf([
    ['D', 'A', 1000], ['D', 'B', 1000],
    ['A', 'B', 500], ['B', 'A', 9000],
  ]);
  const best = tour.optimise('D', ['A', 'B'], t);
  assert.deepEqual(best.order, ['D', 'A', 'B']);
});

test('an impossible route scores as impossible, not as free', () => {
  const t = tableOf([['D', 'A', 1000]]);   // nothing leaves A
  assert.equal(tour.tourCost(['D', 'A', 'B'], t), null);
});

test('a big run still gets an answer, and a sane one', () => {
  // Ten stops is past the point of enumerating. The heuristic must still beat
  // the order they arrived in.
  const ids = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
  const pos = {};
  ids.forEach((id, i) => { pos[id] = i * 1000; });
  pos.D = -1000;
  const pairs = [];
  for (const a of [...ids, 'D']) {
    for (const b of [...ids, 'D']) if (a !== b) pairs.push([a, b, Math.abs(pos[a] - pos[b])]);
  }
  const t = tableOf(pairs);
  const shuffled = ['s7', 's2', 's9', 's0', 's5', 's1', 's8', 's3', 's6', 's4'];
  const best = tour.optimise('D', shuffled, t);
  assert.equal(best.order.length, 11);
  assert.equal(best.cost.distanceM, 10000, 'walking the line once is the optimum');
});

// ── the habit rule ───────────────────────────────────────────────────────────

test('what the driver usually does is read off their own history', () => {
  const history = [
    ['B', 'A', 'C'], ['B', 'A', 'C'], ['A', 'B', 'C'],
    ['A', 'B'],                       // a different trip: must not count
  ];
  const habit = tour.habitualOrder(history, ['A', 'B', 'C']);
  assert.deepEqual(habit.order, ['B', 'A', 'C']);
  assert.equal(habit.times, 2);
});

test('a day with an extra stop says nothing about this trip', () => {
  const habit = tour.habitualOrder([['A', 'B', 'C', 'X']], ['A', 'B', 'C']);
  assert.equal(habit, null);
});

test('a routine is not overturned to save eighty metres', () => {
  // This is the rule the whole feature depends on. The optimiser is right that
  // D,A,B,C is shorter — by 80 m over 3 km — and it must keep that to itself.
  // best  D,A,B,C = 1000 + 1000 + 1000 = 3000
  // habit D,B,A,C = 1040 + 1040 + 1000 = 3080   — eighty metres worse
  const t = tableOf([
    ['D', 'A', 1000], ['D', 'B', 1040],
    ['A', 'B', 1000], ['B', 'A', 1040],
    ['B', 'C', 1000], ['C', 'B', 1000],
    ['A', 'C', 1000], ['C', 'A', 1000],
  ]);
  const best = tour.optimise('D', ['A', 'B', 'C'], t);
  const habit = tour.habitualOrder([['B', 'A', 'C'], ['B', 'A', 'C']], ['A', 'B', 'C']);
  const out = tour.preferHabit(best, habit, t, { startId: 'D' });

  assert.equal(out.cost.distanceM, 3080, 'the habit is what gets shown');
  assert.equal(out.followed, 'driver');
  assert.deepEqual(out.order, ['D', 'B', 'A', 'C']);
  assert.match(out.reason, /too small/);
  assert.ok(out.alternative.savingM < 500, 'and it still records what it would have said');
});

test('a routine IS overturned when the saving is real', () => {
  // Same shape, but the habit now costs an extra three kilometres.
  const t = tableOf([
    ['D', 'A', 1000], ['D', 'B', 4000],
    ['A', 'B', 1000], ['B', 'A', 1000],
    ['B', 'C', 1000], ['A', 'C', 2000], ['C', 'A', 2000], ['C', 'B', 1000],
  ]);
  const best = tour.optimise('D', ['A', 'B', 'C'], t);
  const habit = tour.habitualOrder([['B', 'A', 'C']], ['A', 'B', 'C']);
  const out = tour.preferHabit(best, habit, t, { startId: 'D' });

  assert.equal(out.followed, 'optimiser');
  assert.deepEqual(out.order, ['D', 'A', 'B', 'C']);
  assert.ok(out.savingM > 500);
  assert.ok(out.habit, 'the driver is told what they usually do, not just corrected');
});

test('both tests of significance must pass, not either', () => {
  // A 600 m saving is over the absolute floor, but on a 40 km run it is 1.5%
  // — inside the noise of one traffic light. The routine stands.
  //
  // best  D,A,B,C = 20000 + 10000 + 10000 = 40000
  // habit D,B,A,C = 20600 + 10000 + 10000 = 40600
  const t = tableOf([
    ['D', 'A', 20000], ['D', 'B', 20600],
    ['A', 'B', 10000], ['B', 'A', 10000],
    ['B', 'C', 10000], ['C', 'B', 10000],
    ['A', 'C', 10000], ['C', 'A', 10000],
  ]);
  const best = tour.optimise('D', ['A', 'B', 'C'], t);
  const habit = tour.habitualOrder([['B', 'A', 'C']], ['A', 'B', 'C']);
  const out = tour.preferHabit(best, habit, t, { startId: 'D' });
  assert.equal(out.followed, 'driver');
});

test('a driver with no history yet simply gets the optimiser', () => {
  const best = tour.optimise('D', ['A', 'B', 'C'], LINE);
  const out = tour.preferHabit(best, null, LINE, { startId: 'D' });
  assert.equal(out.followed, 'optimiser');
  assert.deepEqual(out.order, ['D', 'A', 'B', 'C']);
});
