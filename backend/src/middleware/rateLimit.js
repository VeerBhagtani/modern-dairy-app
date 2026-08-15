const rateLimit = require('express-rate-limit');

// In-memory store — accurate for a single Cloud Run instance. If this service
// is ever scaled to multiple concurrent instances, each instance enforces its
// own counter, so the *effective* limit becomes limit × instance count. Swap
// the `store` option for a shared backend (Redis, Firestore) before scaling
// past one instance if these limits need to hold exactly.

const FIFTEEN_MIN = 15 * 60 * 1000;

function jsonHandler(message) {
  return (req, res) => {
    res.status(429).json({ success: false, message: message || 'Too many requests. Please try again later.' });
  };
}

// Auth-sensitive endpoints (login, OTP send/verify, GST lookup, register,
// refresh): 5 attempts per 15 minutes per IP. Applies uniformly whether the
// account/phone exists or not, so the response never leaks existence.
const authLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler('Too many attempts. Please wait 15 minutes and try again.'),
});

// Same budget, but keyed by the target phone number (when present in the
// body) instead of the caller's IP — stops an attacker from spreading an SMS
// bombing / OTP-spam attack against one victim number across many source IPs,
// which a pure per-IP limiter above would not catch.
const otpPhoneLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    return phone || req.ip; // no phone in body -> fall back to IP-only limiting
  },
  skip: (req) => !req.body?.phone,
  handler: jsonHandler('Too many attempts for this phone number. Please wait 15 minutes and try again.'),
});

// Admin login: same 5/15min budget, keyed by IP + attempted username so a
// distributed attacker can't spread guesses across IPs against one admin
// account while a single IP is still capped even against many usernames.
const adminLoginLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${String(req.body?.username || '').toLowerCase().slice(0, 100)}`,
  handler: jsonHandler('Too many sign-in attempts. Please wait 15 minutes and try again.'),
});

// Authenticated write endpoints (place order, wallet top-up request, admin
// writes): generous enough for real usage, tight enough to stop abuse/DoS
// against Firestore writes and third-party API calls that cost money.
const writeLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.adminId || req.ip,
  handler: jsonHandler('Too many requests. Please slow down and try again shortly.'),
});

// General baseline for everything else (reads, config, health) — a backstop
// against scraping/DoS, loose enough not to bother normal app usage.
const generalLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler('Too many requests. Please try again shortly.'),
});

module.exports = { authLimiter, otpPhoneLimiter, adminLoginLimiter, writeLimiter, generalLimiter };
