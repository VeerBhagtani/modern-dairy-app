const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const configRoutes = require('./routes/config');
const authRoutes = require('./routes/auth');
const ordersRoutes = require('./routes/orders');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const { generalLimiter } = require('./middleware/rateLimit');

const app = express();

// Cloud Run sits behind a proxy/load balancer — without this, req.ip is the
// proxy's address for every request, which would make every IP-keyed rate
// limit collapse onto a single shared counter.
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet({
  // A JSON API serves no HTML, so the strictest possible CSP costs nothing
  // and neutralises anything that ever does get reflected into a response.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"] },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// Force HTTPS in production. Cloud Run terminates TLS at the load balancer
// and forwards the original scheme in x-forwarded-proto, so a plain-HTTP
// request reaching this process means credentials and bearer tokens crossed
// the network in the clear — redirect it rather than serving it. Skipped
// when NODE_ENV !== 'production' so localhost development still works.
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto.split(',')[0].trim() !== 'https') {
    return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

// Allowlist-based CORS. ALLOWED_ORIGINS is a comma-separated list (set in
// Cloud Run env config); requests with no Origin header (native app clients,
// curl, server-to-server) are always allowed since CORS is a browser-only
// concept. Falls back to "no browser origin allowed" if unset, which is the
// safe default until the app's real origin(s) are known.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));

app.use(express.json({ limit: '1mb' }));
app.use(generalLimiter);

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/config', configRoutes);
app.use('/auth', authRoutes);
app.use('/orders', ordersRoutes);
app.use('/wallet', walletRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));

// Keep error responses generic to the client; log full detail server-side.
// Malformed JSON bodies (express.json parse failures) get a proper 400
// instead of a misleading 500; everything else stays a generic 500 with no
// stack trace, internal path, or DB error text ever reaching the client.
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
app.listen(PORT, () => console.log(`Modern Dairy backend listening on :${PORT}`));
