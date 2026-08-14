/* ═══════════════════════════════════════════════════════════
   BUILD / ENVIRONMENT CONFIG
   Loaded before the app script. Change API_BASE here per build
   (dev / staging / prod) — never hardcode a server URL inside
   index.html's app logic. Everything here is also overridden by
   the backend /config endpoint at runtime once API_BASE is set,
   so the Admin Panel can change it without an APK rebuild.
   ═══════════════════════════════════════════════════════════ */
window.APP_CONFIG = {
  API_BASE: '',            // e.g. 'https://api.moderndairy.in/api' — leave empty for DEMO mode
  DEMO: true,               // true = works fully offline until API_BASE is set
  RAZORPAY_KEY: '',
};
