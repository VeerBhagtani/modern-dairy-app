/* Modern Drivers dashboard — environment config.
 *
 * API_BASE is the Cloud Run backend. Firebase config is the same public web
 * config the ordering admin panel already uses (a web API key is not a secret;
 * access is controlled by Firestore rules and by the backend's uid check).
 *
 * MAP_STYLE is the only map-provider reference in the whole dashboard, so
 * swapping OpenFreeMap for Mapbox/Google is a one-line change here.
 */
window.DRIVERS_CONFIG = {
  API_BASE: '',   // e.g. 'https://modern-dairy-api-xxxxx.a.run.app' — set per deployment

  firebase: {
    apiKey: 'AIzaSyD-3RNHrI9ZPmdTioLiuCi2gjwdNXZH8HI',
    authDomain: 'modern-dairy-pune.firebaseapp.com',
    projectId: 'modern-dairy-pune',
    storageBucket: 'modern-dairy-pune.firebasestorage.app',
    messagingSenderId: '711745048614',
    appId: '1:711745048614:web:29e8641911c62c1bb856e7',
  },

  // Must stay identical to isAdmin() in backend/firestore.rules and
  // ADMIN_FIREBASE_UID in backend/src/middleware/adminAuth.js.
  ADMIN_UID: '63cH4Dduh4WS7okdV0s0DcJtD7q2',

  MAP_STYLE: 'https://tiles.openfreemap.org/styles/liberty',
  MAP_WORKER: '/vendor/maplibre/maplibre-gl-csp-worker.js',
  // Pune, used only as the map's opening view before any driver is plotted.
  MAP_CENTER: [73.8567, 18.5204],

  // Fallback only. The real value comes from the server on every dashboard
  // load, so the two can never disagree about what "stale" means.
  STALE_AFTER_SEC: 180,
  REFRESH_SEC: 20,
};
