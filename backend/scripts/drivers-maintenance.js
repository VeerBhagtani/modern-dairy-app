#!/usr/bin/env node
/* Modern Drivers scheduled maintenance.
 *
 * Run every 10–15 minutes (Cloud Scheduler hitting a Cloud Run job, or the
 * GitHub Actions workflow .github/workflows/drivers-maintenance.yml).
 *
 *   1. auto-close rides nobody stopped   (audited, never silent)
 *   2. raise and resolve live tracking alerts
 *   3. process finished rides with no result yet
 *   4. enforce the raw-GPS retention policy
 *
 * Retention deletion is OFF by default and must be asked for explicitly with
 * --delete-expired, because it is the one irreversible step in here. Without
 * the flag it reports what it WOULD delete.
 *
 *   node scripts/drivers-maintenance.js                  # safe: dry-run retention
 *   node scripts/drivers-maintenance.js --delete-expired # actually deletes
 */
const { runMaintenance } = require('../src/jobs/driversMaintenance');
const { processOne } = require('../src/routes/driversAdmin');

const deleteExpired = process.argv.includes('--delete-expired');

(async () => {
  const out = await runMaintenance({ processOne, dryRunRetention: !deleteExpired });

  console.log(JSON.stringify({
    at: new Date(out.at).toISOString(),
    autoClosedRides: out.autoClosed || [],
    alerts: out.alerts || null,
    processing: out.processing || null,
    retention: out.retention
      ? { ...out.retention, mode: deleteExpired ? 'deleted' : 'dry-run (pass --delete-expired to delete)' }
      : null,
    errors: out.errors,
  }, null, 2));

  // A non-zero exit makes a failed step visible in CI or Cloud Scheduler
  // instead of a green tick over a silent failure.
  if (out.errors.length) {
    console.error(`${out.errors.length} maintenance step(s) failed.`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('Maintenance run failed:', err);
  process.exit(1);
});
