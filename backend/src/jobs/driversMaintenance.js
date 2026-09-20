// Scheduled maintenance for Modern Drivers. Run it every 10–15 minutes.
//
//  1. Auto-close rides nobody stopped   (never silently — every closure is a
//     status, a reason, an audit row and a tracking event)
//  2. Raise and resolve live tracking alerts
//  3. Process finished rides that have no result yet
//  4. Enforce the retention policy on raw GPS
//
// Each step is independent and failure-isolated: a retention error must not
// stop rides being auto-closed.

const repo = require('../services/driversRepo');
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
async function enforceRetention(cfg, nowMs, { dryRun = false, maxRides = 50 } = {}) {
  const cutoff = nowMs - cfg.retention.rawGpsDays * 24 * 3600 * 1000;
  const snap = await repo.C.rides()
    .where('startedAt', '<', cutoff)
    .orderBy('startedAt')
    .limit(maxRides)
    .get();

  const deleted = []; const skipped = [];
  for (const doc of snap.docs) {
    const ride = { id: doc.id, ...doc.data() };
    if (ride.rawGpsDeletedAt) continue;
    if (!ride.processedAt) { skipped.push({ rideId: ride.id, reason: 'not processed — raw data kept so the day stays auditable' }); continue; }
    if (dryRun) { deleted.push({ rideId: ride.id, dryRun: true }); continue; }
    /* eslint-disable no-await-in-loop */
    // recursiveDelete removes the gps_raw sub-collection in bulk.
    await repo.C.rides().doc(ride.id).collection('gps_raw').listDocuments()
      .then((refs) => {
        const writer = repo.C.rides().firestore.bulkWriter();
        refs.forEach((ref) => writer.delete(ref));
        return writer.close();
      });
    await repo.C.rides().doc(ride.id).update({ rawGpsDeletedAt: nowMs, rawGpsRetentionDays: cfg.retention.rawGpsDays });
    await repo.writeAudit({
      adminId: 'system:retention',
      action: 'gps.retention_delete',
      target: ride.id,
      after: { retentionDays: cfg.retention.rawGpsDays, pointCount: ride.pointCount || null },
    });
    deleted.push({ rideId: ride.id, pointCount: ride.pointCount || null });
  }
  return { deleted: deleted.length, skipped, detail: deleted };
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

  return out;
}

module.exports = { runMaintenance, autoCloseStaleRides, reconcileAlerts, processFinishedRides, enforceRetention };
