/* Build/environment config for the Modern Drivers app.
 *
 * API_BASE is the only value that changes between dev, staging and production.
 * It is set here at build time (see .github/workflows/build-drivers-apk.yml,
 * which writes this file from the DRIVERS_API_BASE secret) and never hardcoded
 * inside app.js.
 *
 * There is no demo/offline mode and no seeded GPS. An app with no API_BASE
 * refuses to start a ride and says so — fake tracking data must never be able
 * to reach a real report.
 */
window.APP_CONFIG = {
  API_BASE: '',                 // e.g. 'https://modern-dairy-api-xxxxx.a.run.app'
  // Fallbacks used only until the server's own values arrive from /driver/me.
  SAMPLE_INTERVAL_SEC: 30,
  MAX_BATCH_POINTS: 200,
  // How often the app asks the server whether the ride is still running, so a
  // remote stop takes effect on the phone promptly.
  RIDE_POLL_SEC: 60,
  // How often queued points are pushed when the network is up.
  SYNC_INTERVAL_SEC: 45,
};
