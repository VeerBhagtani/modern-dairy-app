/* Build/environment config for the Modern Drivers app.
 *
 * API_BASE is written in at build time from the DRIVERS_API_BASE secret, so one
 * source tree produces a staging and a production APK.
 *
 * With no API_BASE the app still works: it records the route on the phone, draws
 * it on the map, and says plainly that nothing has reached the office yet. That
 * is real GPS held locally, not a demo — no coordinate is ever invented.
 */
window.APP_CONFIG = {
  API_BASE: '',

  // Free, open map tiles: no API key, no billing account, no per-view charge.
  // This is the only line in the app that knows who the map provider is.
  MAP_STYLE: 'https://tiles.openfreemap.org/styles/liberty',
  MAP_CENTER: [73.8567, 18.5204],   // Pune, until the first fix arrives

  SAMPLE_INTERVAL_SEC: 30,
  MAX_BATCH_POINTS: 200,
  RIDE_POLL_SEC: 60,
  SYNC_INTERVAL_SEC: 45,
};
