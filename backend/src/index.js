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

// Allowlist CORS. Requests with no Origin (the Android app, curl,
// server-to-server) are always allowed, since CORS is a browser-only concept.
// Unset means "no browser origin allowed", which is the safe default until the
// dashboard's real origin is known.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));

// CSV imports (restaurant locations, order records) arrive as one JSON body and
// legitimately exceed the 1 MB default. Path-scoped and mounted first; the
// global parser below then no-ops for them. Everything else stays at 1 MB.
app.use('/admin/orders/import', express.json({ limit: '8mb' }));
app.use('/admin/restaurants/import', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(generalLimiter);

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'modern-drivers-api' }));

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
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'Origin not allowed' });
  }
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Modern Drivers API listening on :${PORT}`));
