// Scheduled maintenance for Modern Drivers. Run it every 10–15 minutes.
//
//  1. Auto-close rides nobody stopped   (never silently — every closure is a
//     status, a reason, an audit row and a tracking event)
//  2. Raise and resolve live tracking alerts
//  3. Process finished rides that have no result yet
//  4. Enforce the retention policy: raw GPS (180 d), processed results
//     (3 years), tracking events (1 year)
//
// Each step is independent and failure-isolated: a retention error must not
// stop rides being auto-closed.

const repo = require('../services/repo');
const { evaluateRideAlerts, diffAlerts } = require('../drivers/alerts');

// ---------------------------------------------------------------------------

async function autoCloseStaleRides(cfg, nowMs) {
  const rides = await repo.activeRides();
  const closed = [];
  for (const ride of rides) {
    const hours = (nowMs - ride.startedAt) / 3600000;
    if (hours < cfg.autoStopAfterHours) continue;
    /* eslint-disable no-await-in-loop */
    await repo.stopRide(ride.id, {
      by: 'system:timeout',
      // The threshold is written into the reason, so a ride closed last March
      // can still be explained even after the config changes.
      reason: `Automatically closed after ${hours.toFixed(1)} h; the configured limit is ${cfg.autoStopAfterHours} h and no administrator stopped this ride.`,
      kind: 'timeout',
    });
    await repo.C.live().doc(ride.driverId).set({ rideStatus: 'auto_closed', rideStoppedAt: nowMs }, { merge: true }).catch(() => {});
    closed.push({ rideId: ride.id, driverId: ride.driverId, hours: Math.round(hours * 10) / 10 });
  }
  return closed;
}

async function reconcileAlerts(cfg, nowMs) {
  const rides = await repo.activeRides();
  const open = await repo.openAlerts();
  const desired = rides.flatMap((r) => evaluateRideAlerts({ ...r, id: r.id }, cfg, nowMs));

  // Only live-tracking alert kinds take part; result-derived alerts are owned
  // by the processing step and must not be resolved from here.
  const LIVE_KINDS = new Set(['gps_missing', 'location_stale', 'ride_too_long', 'tracking_permission_lost']);
  const openLive = open.filter((a) => LIVE_KINDS.has(a.kind));
  const diff = diffAlerts(desired, openLive);
  // A permission alert is resolved by the phone reporting healthy again, not by
  // the ride ending; keep it if the ride is still active.
  diff.toResolve = diff.toResolve.filter((a) => a.kind !== 'tracking_permission_lost' || !rides.some((r) => r.id === a.rideId));
  await repo.applyAlertDiff(diff, 'system:maintenance');
  return { raised: diff.toRaise.length, resolved: diff.toResolve.length };
}

async function processFinishedRides(processOne, { limit = 25 } = {}) {
  // Rides that finished in the last three days and have no processed result.
  const from = Date.now() - 3 * 24 * 3600 * 1000;
  const rides = await repo.listRides({ from, limit: 300 });
  const pending = [];
  for (const r of rides) {
    if (r.status === 'active') continue;
    if (r.processedAt) continue;
    pending.push(r);
  }
  const done = []; const failed = [];
  for (const ride of pending.slice(0, limit)) {
    try { /* eslint-disable-next-line no-await-in-loop */ await processOne(ride.id); done.push(ride.id); }
    catch (e) { failed.push({ rideId: ride.id, error: e.message }); }
  }
  return { processed: done.length, pending: pending.length, failed };
}

// Retention. Raw points are deleted only when the ride HAS a processed result —
// deleting the evidence while keeping a number nobody can re-derive would make
// every report unauditable, which is worse than keeping the data a while longer.

/* Which of these rides (all older than the cutoff) to clear now. Pure. */
function retentionDecision(ride) {
  if (ride.rawGpsDeletedAt) return 'done';
  if (!ride.processedAt) return 'keep';
  return 'delete';
}

async function enforceRetention(cfg, nowMs, { dryRun = false, maxRides = 50, maxScan = 2000 } = {}) {
  const cutoff = nowMs - cfg.retention.rawGpsDays * 24 * 3600 * 1000;
  const deleted = []; const skipped = [];
  // Paged through, oldest first. Reading only the first page (as before) meant
  // that once its rides were cleared, every run read the same cleared rides
  // and never reached the next ones.
  let last = null; let scanned = 0;
  while (deleted.length < maxRides && scanned < maxScan) {
    let q = repo.C.rides().where('startedAt', '<', cutoff).orderBy('startedAt').limit(200);
    if (last) q = q.startAfter(last);
    /* eslint-disable no-await-in-loop */
    const snap = await q.get();
    if (snap.empty) break;
    scanned += snap.size;
    last = snap.docs[snap.docs.length - 1];
    for (const doc of snap.docs) {
      if (deleted.length >= maxRides) break;
      const ride = { id: doc.id, ...doc.data() };
      const what = retentionDecision(ride);
      if (what === 'done') continue;
      if (what === 'keep') { skipped.push({ rideId: ride.id, reason: 'not processed — raw data kept so the day stays auditable' }); continue; }
      if (dryRun) { deleted.push({ rideId: ride.id, dryRun: true }); continue; }
      // The gps_raw sub-collection, in bulk.
      const refs = await repo.C.rides().doc(ride.id).collection('gps_raw').listDocuments();
      const writer = repo.C.rides().firestore.bulkWriter();
      refs.forEach((ref) => writer.delete(ref));
      await writer.close();
      await repo.C.rides().doc(ride.id).update({ rawGpsDeletedAt: nowMs, rawGpsRetentionDays: cfg.retention.rawGpsDays });
      await repo.writeAudit({
        adminId: 'system:retention',
        action: 'gps.retention_delete',
        target: ride.id,
        after: { retentionDays: cfg.retention.rawGpsDays, pointCount: ride.pointCount || null, deletedPoints: refs.length },
      });
      deleted.push({ rideId: ride.id, pointCount: ride.pointCount || null });
    }
    if (snap.size < 200) break;
    /* eslint-enable no-await-in-loop */
  }
  return { deleted: deleted.length, skipped, scanned, detail: deleted };
}

// ---------------------------------------------------------------------------
// Processed results (3 years) and tracking events (1 year).
//
// Same rules as raw GPS: never an active ride, never a ride with no result,
// idempotent (a second run finds nothing left to do), and every deletion
// leaves an audit row. The ride document itself is kept, with the day's
// kilometre totals copied onto it first, so a four-year-old month still adds
// up even though its segment-by-segment detail is gone.

/* What to do with one ride older than the processed-result cutoff. Pure. */
function processedRetentionDecision(ride) {
  if (ride.status === 'active') return 'keep';
  if (ride.processedResultDeletedAt) return 'done';
  if (!ride.processedAt) return 'keep';
  return 'delete';
}

/* The totals worth keeping once the detail goes. Pure. */
function retainedSummary(head) {
  const d = head && head.distance;
  if (!d || !d.km) return null;
  return { km: { ...d.km }, calcVersion: head.calcVersion || null, reconciled: !!(d.reconciliation && d.reconciliation.ok) };
}

async function enforceProcessedRetention(cfg, nowMs, { dryRun = false, maxRides = 20, maxScan = 2000 } = {}) {
  const days = cfg.retention.processedDays;
  const cutoff = nowMs - days * 24 * 3600 * 1000;
  const deleted = []; const skipped = [];
  let last = null; let scanned = 0;
  /* eslint-disable no-await-in-loop */
  while (deleted.length < maxRides && scanned < maxScan) {
    let q = repo.C.rides().where('startedAt', '<', cutoff).orderBy('startedAt').limit(200);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    scanned += snap.size;
    last = snap.docs[snap.docs.length - 1];
    for (const doc of snap.docs) {
      if (deleted.length >= maxRides) break;
      const ride = { id: doc.id, ...doc.data() };
      const what = processedRetentionDecision(ride);
      if (what === 'done') continue;
      if (what === 'keep') { skipped.push({ rideId: ride.id, reason: ride.status === 'active' ? 'active ride' : 'no processed result' }); continue; }
      if (dryRun) { deleted.push({ rideId: ride.id, dryRun: true }); continue; }
      const headDoc = await repo.C.processing().doc(ride.id).get();
      const summary = headDoc.exists ? retainedSummary(headDoc.data()) : null;
      const segRefs = await repo.C.segments(ride.id).listDocuments();
      const matchSnap = await repo.C.matches().where('rideId', '==', ride.id).select().get();
      const writer = repo.C.rides().firestore.bulkWriter();
      segRefs.forEach((ref) => writer.delete(ref));
      matchSnap.docs.forEach((d) => writer.delete(d.ref));
      writer.delete(repo.C.processing().doc(ride.id));
      await writer.close();
      await repo.C.rides().doc(ride.id).update({ processedResultDeletedAt: nowMs, processedRetentionDays: days, retainedSummary: summary });
      await repo.writeAudit({
        adminId: 'system:retention',
        action: 'result.retention_delete',
        target: ride.id,
        after: { retentionDays: days, segments: segRefs.length, matches: matchSnap.size, summaryKept: !!summary },
      });
      deleted.push({ rideId: ride.id, segments: segRefs.length, matches: matchSnap.size });
    }
    if (snap.size < 200) break;
  }
  /* eslint-enable no-await-in-loop */
  return { deleted: deleted.length, skipped, scanned, detail: deleted };
}

async function enforceEventRetention(cfg, nowMs, { dryRun = false, maxDelete = 2000 } = {}) {
  const days = cfg.retention.trackingEventDays;
  const cutoff = nowMs - days * 24 * 3600 * 1000;
  // An event that belongs to a ride still running is kept, however old; a ride
  // that has been open for a year is itself something to investigate.
  const active = new Set((await repo.activeRides()).map((r) => r.id));
  let deleted = 0; let kept = 0; let last = null;
  /* eslint-disable no-await-in-loop */
  while (deleted < maxDelete) {
    let q = repo.C.events().where('at', '<', cutoff).orderBy('at').limit(400);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    last = snap.docs[snap.docs.length - 1];
    const doomed = snap.docs.filter((d) => !active.has(d.get('rideId')));
    kept += snap.size - doomed.length;
    const batch = doomed.slice(0, maxDelete - deleted);
    if (!dryRun && batch.length) {
      const writer = repo.C.events().firestore.bulkWriter();
      batch.forEach((d) => writer.delete(d.ref));
      await writer.close();
    }
    deleted += batch.length;
    if (snap.size < 400) break;
  }
  /* eslint-enable no-await-in-loop */
  if (deleted && !dryRun) {
    await repo.writeAudit({ adminId: 'system:retention', action: 'events.retention_delete', after: { retentionDays: days, deleted, keptForActiveRides: kept } });
  }
  return { deleted, keptForActiveRides: kept, dryRun };
}

async function runMaintenance({ processOne, dryRunRetention = false } = {}) {
  const { config } = await repo.getConfig({ fresh: true });
  const nowMs = Date.now();
  const out = { at: nowMs, errors: [] };

  const step = async (name, fn) => {
    try { out[name] = await fn(); } catch (e) { out.errors.push({ step: name, error: e.message }); }
  };

  await step('autoClosed', () => autoCloseStaleRides(config, nowMs));
  await step('alerts', () => reconcileAlerts(config, nowMs));
  if (processOne) await step('processing', () => processFinishedRides(processOne));
  await step('retention', () => enforceRetention(config, nowMs, { dryRun: dryRunRetention }));
  await step('resultRetention', () => enforceProcessedRetention(config, nowMs, { dryRun: dryRunRetention }));
  await step('eventRetention', () => enforceEventRetention(config, nowMs, { dryRun: dryRunRetention }));

  return out;
}

module.exports = {
  runMaintenance, autoCloseStaleRides, reconcileAlerts, processFinishedRides,
  enforceRetention, retentionDecision,
  enforceProcessedRetention, processedRetentionDecision, retainedSummary, enforceEventRetention,
};
