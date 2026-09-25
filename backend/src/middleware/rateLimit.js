const crypto = require('crypto');
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

// Who a write is counted against: the signed-in account, never the network.
//
// Drivers were missing from this list, so every driver write fell through to
// req.ip. Indian mobile carriers put thousands of phones behind a few shared
// addresses (carrier-grade NAT), and the depot's own Wi-Fi is one address for
// everyone on it — so the whole fleet shared ONE budget of 30 writes, and a
// few drivers pressing Start Ride at the same time locked out everyone else
// with a 429. The IP is only the fallback for a request with no identity.
function writeKey(req) {
  if (req.driverId) return `driver:${req.driverId}`;
  if (req.userId) return `user:${req.userId}`;
  if (req.adminId) return `admin:${req.adminId}`;
  return `ip:${req.ip}`;
}

// Authenticated write endpoints (place order, wallet top-up request, admin
// writes): generous enough for real usage, tight enough to stop abuse/DoS
// against Firestore writes and third-party API calls that cost money.
const writeLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: writeKey,
  handler: jsonHandler('Too many requests. Please slow down and try again shortly.'),
});

// General baseline for everything else (reads, config, health) — a backstop
// against scraping/DoS, loose enough not to bother normal app usage. Counted
// per IP because it runs before anyone is identified, and the office is
// several people behind one address, each dashboard refreshing every 20 s and
// a location audit making a hundred calls: 300 was reachable on a busy
// morning. The per-account write limits below are the real control.
const generalLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler('Too many requests. Please try again shortly.'),
});

// Long office jobs that the dashboard runs as a loop of batches (the location
// audit, the location lookup): about a hundred calls for three thousand
// restaurants. Under writeLimiter's 30 they stalled a third of the way in.
// Per signed-in admin, and still bounded, because each call costs Google
// requests.
const batchLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: writeKey,
  handler: jsonHandler('Too many batches in a short time. Wait a few minutes and carry on — nothing is lost.'),
});

// Admin password-recovery texts: ONE budget for the whole service rather than
// per IP. The targets are two fixed numbers, so a per-IP limit would still let
// many machines together ring the owner's phones all night.
const recoverySendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => 'admin-recovery',
  handler: jsonHandler('Too many codes have been requested. Please wait an hour and try again.'),
});

// GPS upload. A driver sampling every 30 s and uploading in small batches makes
// ~30 requests per 15 minutes; a phone catching up after an hour offline makes a
// burst of them. 240/15min per DRIVER leaves ample headroom for the catch-up
// case while still capping a compromised token, and keying on the driver id
// means one driver on a bad network cannot exhaust the budget for the fleet.
const gpsIngestLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.driverId || req.ip,
  handler: jsonHandler('Too many location uploads. The app will retry automatically.'),
});

// Driver registration. A driver legitimately hits this after installing, after
// reinstalling, and when they change handset, so it cannot be miserly — but it
// is also the one endpoint that creates accounts, so it is capped per IP to
// stop anyone enumerating or mass-creating drivers. Per IP, and therefore
// shared by every phone on the depot Wi-Fi on the morning the app is rolled
// out: sized for forty phones registering together, with room over.
const registerLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler('Too many attempts. Please wait 15 minutes and try again.'),
});

// Token refresh, per refresh token rather than per IP. Every phone refreshes
// its access token about every half hour; counted per address, forty phones
// on one depot Wi-Fi shared twenty refreshes between them, and the ones over
// the limit could not upload at all until the window passed.
const refreshLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const t = String(req.body?.refreshToken || '');
    return t ? `refresh:${crypto.createHash('sha256').update(t).digest('hex').slice(0, 32)}` : `ip:${req.ip}`;
  },
  handler: jsonHandler('Too many attempts. Please wait 15 minutes and try again.'),
});

// Everything a signed-in driver's phone does that is not an upload or a write:
// checking its ride, loading stops, its history. Per driver, for the same
// reason as writeKey. Mounted after the driver is identified.
const driverLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.driverId ? `driver:${req.driverId}` : `ip:${req.ip}`),
  handler: jsonHandler('Too many requests. The app will retry shortly.'),
});

module.exports = {
  refreshLimiter, driverLimiter,
  authLimiter, otpPhoneLimiter, adminLoginLimiter, writeLimiter, generalLimiter,
  gpsIngestLimiter, registerLimiter, writeKey, batchLimiter,
};
