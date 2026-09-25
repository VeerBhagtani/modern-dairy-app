// Retention of processed results (3 years) and tracking events (1 year):
// run against an in-memory Firestore through the real job code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { makeDb } = require('../tests/helpers/fake-firestore.cjs');

const DAY = 864e5;
const NOW = Date.parse('2026-09-25T00:00:00Z');
const cfg = { retention: { rawGpsDays: 180, processedDays: 1095, trackingEventDays: 365 } };

function load() {
  const db = makeDb();
  const audit = [];
  const repo = {
    C: {
      rides: () => db.collection('rides'),
      processing: () => db.collection('ride_processing'),
      segments: (id) => db.collection('ride_processing').doc(id).collection('segments'),
      matches: () => db.collection('delivery_matches'),
      events: () => db.collection('tracking_events'),
    },
    writeAudit: async (row) => { audit.push(row); },
    activeRides: async () => (await db.collection('rides').where('status', '==', 'active').get()).docs.map((d) => ({ id: d.id, ...d.data() })),
  };
  const repoId = require.resolve('./src/services/repo');
  const mId = require.resolve('./src/jobs/maintenance');
  delete require.cache[mId];
  require.cache[repoId] = { id: repoId, filename: repoId, loaded: true, exports: repo };
  const m = require('./src/jobs/maintenance');
  delete require.cache[repoId];
  delete require.cache[mId];
  return { db, audit, m };
}

async function seedRide(db, id, { daysAgo, status = 'completed', processed = true, segs = 3, matches = 2 }) {
  await db.collection('rides').doc(id).set({ startedAt: NOW - daysAgo * DAY, status, ...(processed ? { processedAt: NOW - daysAgo * DAY + 1 } : {}) });
  if (!processed) return;
  await db.collection('ride_processing').doc(id).set({ calcVersion: '1.2.0', distance: { km: { verifiedBusiness: 12.3, measured: 20 }, reconciliation: { ok: true } } });
  for (let i = 0; i < segs; i += 1) await db.collection('ride_processing').doc(id).collection('segments').doc(`seg_${i}`).set({ index: i });
  for (let i = 0; i < matches; i += 1) await db.collection('delivery_matches').doc(`${id}_m${i}`).set({ rideId: id });
}

test('processed results older than 3 years are deleted, totals kept on the ride, audited', async () => {
  const { db, audit, m } = load();
  await seedRide(db, 'old', { daysAgo: 1200 });
  await seedRide(db, 'recent', { daysAgo: 400 });
  const out = await m.enforceProcessedRetention(cfg, NOW);
  assert.equal(out.deleted, 1);
  assert.equal((await db.collection('ride_processing').doc('old').get()).exists, false);
  assert.equal((await db.collection('ride_processing').doc('old').collection('segments').listDocuments()).length, 0);
  assert.equal((await db.collection('delivery_matches').where('rideId', '==', 'old').get()).size, 0);
  const ride = (await db.collection('rides').doc('old').get()).data();
  assert.equal(ride.processedResultDeletedAt, NOW);
  assert.equal(ride.retainedSummary.km.verifiedBusiness, 12.3, 'the day still adds up');
  assert.equal(audit[0].action, 'result.retention_delete');
  // The recent one is untouched.
  assert.equal((await db.collection('ride_processing').doc('recent').get()).exists, true);
  assert.equal((await db.collection('delivery_matches').where('rideId', '==', 'recent').get()).size, 2);
});

test('result retention never touches an active ride or a ride with no result, and is idempotent', async () => {
  const { db, audit, m } = load();
  await seedRide(db, 'running', { daysAgo: 1200, status: 'active' });
  await seedRide(db, 'unprocessed', { daysAgo: 1200, processed: false });
  await seedRide(db, 'old', { daysAgo: 1200 });
  const first = await m.enforceProcessedRetention(cfg, NOW);
  assert.equal(first.deleted, 1);
  assert.deepEqual(first.skipped.map((s) => s.rideId).sort(), ['running', 'unprocessed']);
  assert.equal((await db.collection('ride_processing').doc('running').get()).exists, true);
  const second = await m.enforceProcessedRetention(cfg, NOW);
  assert.equal(second.deleted, 0, 'nothing left to do');
  assert.equal(audit.length, 1, 'one audit row, not two');
  // Dry run deletes nothing.
  await seedRide(db, 'old2', { daysAgo: 1300 });
  const dry = await m.enforceProcessedRetention(cfg, NOW, { dryRun: true });
  assert.equal(dry.deleted, 1);
  assert.equal((await db.collection('ride_processing').doc('old2').get()).exists, true);
});

test('decision table', () => {
  const { m } = load();
  assert.equal(m.processedRetentionDecision({ status: 'active', processedAt: 1 }), 'keep');
  assert.equal(m.processedRetentionDecision({ processedAt: 1, processedResultDeletedAt: 2 }), 'done');
  assert.equal(m.processedRetentionDecision({}), 'keep');
  assert.equal(m.processedRetentionDecision({ processedAt: 1, status: 'completed' }), 'delete');
  assert.equal(m.retainedSummary({}), null);
});

test('tracking events older than a year are deleted, except those of a running ride', async () => {
  const { db, audit, m } = load();
  await db.collection('rides').doc('running').set({ status: 'active', startedAt: NOW - 400 * DAY });
  for (let i = 0; i < 5; i += 1) await db.collection('tracking_events').doc(`old${i}`).set({ at: NOW - 400 * DAY, rideId: 'done-ride' });
  await db.collection('tracking_events').doc('oldActive').set({ at: NOW - 400 * DAY, rideId: 'running' });
  await db.collection('tracking_events').doc('new').set({ at: NOW - 10 * DAY, rideId: 'done-ride' });
  const out = await m.enforceEventRetention(cfg, NOW);
  assert.equal(out.deleted, 5);
  assert.equal(out.keptForActiveRides, 1);
  const left = (await db.collection('tracking_events').listDocuments()).map((r) => r.id).sort();
  assert.deepEqual(left, ['new', 'oldActive']);
  assert.equal(audit.at(-1).action, 'events.retention_delete');
  const again = await m.enforceEventRetention(cfg, NOW);
  assert.equal(again.deleted, 0);
  assert.equal(audit.length, 1, 'no audit row when nothing was deleted');
});

test('the retention jobs are scheduled by the housekeeping, each failure-isolated', async () => {
  const fs = await import('fs');
  const rp = fs.readFileSync(path.join(ROOT, 'backend/src/services/rideProcessing.js'), 'utf8');
  assert.match(rp, /retention\.results = await enforceProcessedRetention\(config, nowMs, \{ maxRides: 20 \}\)/);
  assert.match(rp, /retention\.events = await enforceEventRetention\(config, nowMs, \{ maxDelete: 2000 \}\)/);
  const { DEFAULTS } = require('./src/drivers/config');
  assert.equal(DEFAULTS.retention.processedDays, 1095);
  assert.equal(DEFAULTS.retention.trackingEventDays, 365);
});
