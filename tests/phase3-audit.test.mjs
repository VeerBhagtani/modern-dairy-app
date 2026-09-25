// Phase 3: the production-readiness fixes, and the known defects re-tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { processRideData } = require('./src/drivers/pipeline');
const { retentionDecision } = require('./src/jobs/maintenance');

// ── known defect 3: orders with only a delivery window ────────────────────
test('defect 3: an order with only a delivery window is loaded and matches the visit', () => {
  const repo = read('backend/src/services/repo.js');
  const fn = repo.slice(repo.indexOf('async function ordersForRide'), repo.indexOf('async function declarationsForRide'));
  assert.match(fn, /\['orderedAt', 'windowStart', 'windowEnd', 'deliveredAt'\]\.map/);

  // And the engine uses the window when there is no orderedAt.
  const T0 = Date.parse('2026-09-15T04:00:00Z');
  const R = { id: 'R', name: 'R', customerId: 'CUST', lat: 18.52, lng: 73.85, radiusM: 80 };
  const pts = [];
  for (let i = 0; i <= 20; i += 1) pts.push({ clientPointId: `p:${i}`, lat: R.lat - 0.02 + i * 0.001, lng: R.lng, deviceTs: T0 + i * 20000, accuracyM: 8 });
  for (let i = 1; i <= 12; i += 1) pts.push({ clientPointId: `s:${i}`, lat: R.lat, lng: R.lng, deviceTs: T0 + 400000 + i * 20000, accuracyM: 8 });
  const order = { id: 'O1', customerId: 'CUST', windowStart: T0 + 300000, windowEnd: T0 + 900000, assignedDriverId: 'drv' };
  const r = processRideData({ points: pts, ride: { id: 'x', driverId: 'drv', startedAt: T0 }, facilities: [], restaurants: [R],
    orders: [order], declarations: [], reviews: [], nowMs: T0 + 864e5 });
  const visit = r.segments.find((s) => s.type === 'LIKELY_RESTAURANT_VISIT');
  assert.ok(visit, 'a visit');
  assert.equal(visit.confidence, 'HIGH', 'corroborated by the window-only order');
  assert.equal(r.matching.summary.matched, 1);
  // A window hours away is not a match, however well the place fits.
  const far = { ...order, id: 'O2', windowStart: T0 + 10 * 3600e3, windowEnd: T0 + 11 * 3600e3 };
  const r2 = processRideData({ points: pts, ride: { id: 'x', driverId: 'drv', startedAt: T0 }, facilities: [], restaurants: [R],
    orders: [far], declarations: [], reviews: [], nowMs: T0 + 864e5 });
  assert.equal(r2.matching.summary.matched + r2.matching.summary.possible, 0);
});

// ── known defect 4: the maintenance audit's field paths ────────────────────
test('defect 4: the maintenance audit reads fields that exist', () => {
  const hf = read('backend/src/services/healthFacts.js');
  assert.doesNotMatch(hf, /r\.distance\.residualM/);
  assert.doesNotMatch(hf, /r\.counts && r\.counts\.pendingReview/);
  assert.doesNotMatch(hf, /d\.lastRideAt/);
  assert.doesNotMatch(hf, /matches\(\)\.where\('at'/);
  assert.match(hf, /r\.distance\.reconciliation/);
  assert.match(hf, /r\.review && r\.review\.pending/);
  assert.match(hf, /matches\(\)\.where\('visitAt'/);
  // Those fields are what the pipeline actually produces.
  const r = processRideData({ points: [], ride: { id: 'x' }, facilities: [], restaurants: [], orders: [], declarations: [], reviews: [], nowMs: Date.now() });
  assert.ok('bucketResidualM' in r.distance.reconciliation && 'totalResidualM' in r.distance.reconciliation);
  assert.ok('pending' in r.review);
});

// ── retention ──────────────────────────────────────────────────────────────
test('180-day raw GPS retention: runs by itself, pages through old rides, never deletes unprocessed evidence', () => {
  assert.equal(retentionDecision({ processedAt: 1 }), 'delete');
  assert.equal(retentionDecision({}), 'keep', 'no result yet: keep the evidence');
  assert.equal(retentionDecision({ processedAt: 1, rawGpsDeletedAt: 2 }), 'done');
  const m = read('backend/src/jobs/maintenance.js');
  assert.match(m, /if \(last\) q = q\.startAfter\(last\);/, 'pages on, instead of re-reading the first page');
  const rp = read('backend/src/services/rideProcessing.js');
  assert.match(rp, /retention = await enforceRetention\(config, nowMs, \{ maxRides: 20 \}\)/, 'scheduled, not a dry run');
  const { DEFAULTS } = require('./src/drivers/config');
  assert.equal(DEFAULTS.retention.rawGpsDays, 180);
});

// ── office sessions ───────────────────────────────────────────────────────
test('an office token stops working when the account is disabled or its password changes', () => {
  const auth = read('backend/src/middleware/adminAuth.js');
  const fn = auth.slice(auth.indexOf('function requireAdmin()'));
  assert.match(fn, /const account = await currentAccount\(payload\.sub\);/);
  assert.match(fn, /account\.status === 'disabled'/);
  assert.match(fn, /payload\.iat \* 1000 < account\.passwordChangedAt/);
  assert.match(fn, /req\.adminRole = ROLES\[account\.role\]/, 'the role as it is now, not as it was at sign-in');
  const admin = read('backend/src/routes/admin.js');
  assert.match(admin, /passwordChangedAt: Date\.now\(\),/);
});

// ── CI, CORS, secrets ─────────────────────────────────────────────────────
test('nothing is deployed, published or built without the full test suite passing', () => {
  for (const wf of ['deploy.yml', 'dashboard.yml', 'release.yml']) {
    const s = read(`.github/workflows/${wf}`);
    const t = s.indexOf('name: Run the test suite');
    assert.ok(t !== -1, wf);
    assert.match(s.slice(t, t + 200), /npm ci[\s\S]*npm test/, wf);
    // `node --test "tests/*.test.mjs"` needs Node 21+ to expand the pattern;
    // on Node 20 it finds no files and the gate fails every build.
    assert.match(s, /node-version: 22/, wf);
  }
});

test('a refused browser origin gets a 403, not a 500', () => {
  const index = read('backend/src/index.js');
  assert.match(index, /err\.corsRefused = true;/);
  assert.match(index, /if \(err\.corsRefused\) \{/);
});

test('the office password is not in the repository', () => {
  const { execSync } = require('child_process');
  // Built in pieces so this file does not match itself.
  const needle = ['Mdairy', 'pune'].join('');
  const hits = execSync(`git grep -n -i "${needle}" -- . || true`, { cwd: ROOT }).toString().trim();
  assert.equal(hits, '', hits);
});

test('Cloud Run is capped at a few instances', () => {
  assert.match(read('.github/workflows/deploy.yml'), /--max-instances 4/);
});
