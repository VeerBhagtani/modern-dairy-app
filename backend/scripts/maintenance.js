#!/usr/bin/env node
/* Scheduled maintenance. Run every 10-15 minutes.
 *
 *   1. auto-close rides nobody stopped   (audited, never silent)
 *   2. raise and resolve live tracking alerts
 *   3. process finished rides with no result yet
 *   4. report what the raw-GPS retention policy would delete
 *
 * Retention deletion is OFF unless --delete-expired is passed, because it is
 * the one irreversible step in here.
 */
const { runMaintenance } = require('../src/jobs/maintenance');
const { processOne } = require('../src/routes/admin');

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
  if (out.errors.length) {
    console.error(`${out.errors.length} maintenance step(s) failed.`);
    process.exit(1);
  }
})().catch((err) => { console.error('Maintenance run failed:', err); process.exit(1); });
