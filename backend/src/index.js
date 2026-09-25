// Modern Drivers API.
//
// A standalone service. It shares no code and no database with the Modern
// Dairy ordering app — the two are separate products that happen to belong to
// the same company, and keeping them apart means neither can break the other.
//
// Two surfaces:
//   /driver   the Android app: enrolment, start ride, GPS upload, health
//   /admin    the office dashboard: fleet, ride control, review, reports

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { router: driverRoutes } = require('./routes/driver');
const { router: adminRoutes } = require('./routes/admin');
const { requireAdmin, adminLoginHandler } = require('./middleware/adminAuth');
const { generalLimiter, adminLoginLimiter } = require('./middleware/rateLimit');

const app = express();

// Cloud Run sits behind a load balancer. Without this, req.ip is the proxy's
// address for every request and every IP-keyed rate limit collapses into one
// shared counter.
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet({
  // A JSON API serves no HTML, so the strictest possible CSP costs nothing and
  // neutralises anything that ever does get reflected into a response.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"] },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// Force HTTPS in production. Location data must never cross the network in the
// clear; a plain-HTTP request reaching this process means it already did once,
// so redirect rather than serve it.
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto.split(',')[0].trim() !== 'https') {
    return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

// Allowlist CORS. Requests with no Origin at all (curl, server-to-server) are
// allowed, since CORS is a browser-only concept and a client that sends no
// Origin was never subject to it.
//
// The Android app IS subject to it. It is a WebView, not a native HTTP client,
// so it sends an Origin like any browser — "https://localhost" on Android under
// Capacitor's https scheme. That origin has to be in the list or the phone's own
// browser refuses the call before it leaves the device. An earlier version of
// this comment claimed the app sent no Origin; it was wrong, and the cost was a
// fleet of phones that could not start a ride.
//
// Unset means "no browser origin allowed", which is the safe default until the
// real origins are known.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    // A refused origin is invisible from the outside: the browser reports only
    // "Failed to fetch" — no status, no body, nothing in the network tab that
    // names the cause. So the server says out loud what it refused and what it
    // would have accepted. Neither is a secret; the client that sent the origin
    // already knows it, and the allowlist is in a public workflow file.
    console.warn(
      '[cors] refused origin %s — allowed: %s',
      origin,
      allowedOrigins.join(', ') || '(none configured)',
    );
    const err = new Error(`Origin ${origin} is not allowed to call this API.`);
    err.status = 403;
    err.corsRefused = true;
    callback(err);
  },
}));

// CSV imports (restaurant locations, order records) arrive as one JSON body and
// legitimately exceed the 1 MB default. Path-scoped and mounted first; the
// global parser below then no-ops for them. Everything else stays at 1 MB.
app.use('/admin/orders/import', express.json({ limit: '8mb' }));
app.use('/admin/restaurants/import', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '1mb' }));
// The general per-IP backstop, for everything except the drivers' phones.
// Those have their own limits, counted per driver once the driver is known
// (routes/driver.js). Counted here per IP, before anybody is identified, the
// whole fleet shared one budget — mobile carriers put thousands of phones
// behind a few addresses, and the depot Wi-Fi is one — and after 300 requests
// every phone's GPS uploads were refused.
app.use((req, res, next) => (req.path.startsWith('/driver/') ? next() : generalLimiter(req, res, next)));

// Two names for one check, and /health is the one to rely on.
//
// Google's frontend swallows /healthz on Cloud Run: the request never reaches
// this process and the caller gets Google's own 404 page, while every other
// path on the same service arrives here normally. That is worth a comment
// because a genuinely broken service and a service whose health endpoint is
// being intercepted look identical from outside — the giveaway was that "/"
// came back with this app's own headers while "/healthz" did not.
//
// /healthz stays for anything already pointed at it; it works locally and
// anywhere that is not behind Google's frontend.
const health = (req, res) => res.json({ ok: true, service: 'modern-drivers-api' });
app.get('/health', health);
app.get('/healthz', health);

// The office signs in here and gets a short-lived admin token. This service has
// no Firebase Auth dependency of its own — one fewer thing to set up, and one
// fewer identity system shared with an unrelated product.
app.post('/admin/login', adminLoginLimiter, adminLoginHandler);

app.use('/driver', driverRoutes);
app.use('/admin', requireAdmin(), adminRoutes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));

// Generic errors to the client, full detail to the log. A malformed JSON body
// gets a proper 400 rather than a misleading 500; nothing else ever leaks a
// stack trace, an internal path or a database error string.
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ success: false, message: 'Malformed request body' });
  }
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ success: false, message: 'Request body is too large' });
  }
  // (This compared the message with a string the CORS check never used, so a
  // refused origin came back as a 500.)
  if (err.corsRefused) {
    return res.status(403).json({ success: false, message: 'Origin not allowed' });
  }
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// A last line of defence. Node's default for an unhandled rejection is to kill
// the process, which on Cloud Run means every request gets a 503 — including
// the forty phones trying to report a position — because of one failing code
// path somewhere else. Logging loudly and staying up is the right trade for a
// service whose job is to keep receiving data.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (the service is staying up):', reason);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Modern Drivers API listening on :${PORT}`);
  // After listening, never before: the seed touches Firestore, and the service
  // must come up and answer whether or not that succeeds.
  require('./services/seedAdmin').seedAdminOnStartup();
});
