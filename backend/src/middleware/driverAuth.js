// Driver authentication.
//
// Drivers get no password. An admin issues a one-time enrolment code, the
// driver types it once in the app, and the phone holds a refresh token from
// then on. That removes the two worst failure modes of a 40-driver fleet — a
// forgotten password at 6 a.m. and a shared password everyone knows — without
// putting an SMS bill in the critical path.
//
// A driver token can only ever address its own driverId. There is no parameter
// anywhere in the driver API that names a different driver.

const jwt = require('jsonwebtoken');
const { getSecret } = require('../services/secretManager');
const repo = require('../services/driversRepo');

const ACCESS_TTL = '30m';   // longer than the customer app's 15m: a driver on a
                            // bike in a dead zone must not be logged out mid-ride
const REFRESH_TTL = '90d';  // a working phone should not need re-enrolling each quarter

async function signingKey() {
  const key = await getSecret('jwt-signing-key');
  if (!key) throw new Error('jwt-signing-key not configured in Secret Manager.');
  return key;
}

async function issueDriverTokens(driverId, deviceId) {
  const key = await signingKey();
  const claims = { sub: driverId, did: deviceId, scope: 'driver' };
  return {
    accessToken: jwt.sign({ ...claims, type: 'driver_access' }, key, { expiresIn: ACCESS_TTL, algorithm: 'HS256' }),
    refreshToken: jwt.sign({ ...claims, type: 'driver_refresh' }, key, { expiresIn: REFRESH_TTL, algorithm: 'HS256' }),
  };
}

async function verifyDriverToken(token, expectedType) {
  const key = await signingKey();
  // Algorithm pinned: never trust the alg named in the token's own header.
  const payload = jwt.verify(token, key, { algorithms: ['HS256'] });
  if (payload.type !== expectedType) throw new Error('wrong token type');
  return payload;
}

// Attaches req.driver (the full document) and req.driverId.
//
// The driver document is re-read on every request rather than trusted from the
// token. A deactivated driver, or one whose phone was re-enrolled onto a new
// device, stops working immediately instead of at token expiry — which for a
// 90-day refresh token would be far too late.
function requireDriver() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ success: false, message: 'Sign in again on this device.' });

      const payload = await verifyDriverToken(token, 'driver_access');
      const driver = await repo.getDriver(payload.sub);
      if (!driver) return res.status(401).json({ success: false, message: 'This driver account no longer exists.' });
      if (driver.status !== 'active') {
        return res.status(403).json({ success: false, message: 'This driver account has been deactivated. Contact the office.' });
      }
      if (driver.deviceId && payload.did && driver.deviceId !== payload.did) {
        return res.status(401).json({ success: false, message: 'This account has been set up on another phone. Ask the office for a new code.' });
      }
      req.driver = driver;
      req.driverId = driver.id;
      next();
    } catch {
      res.status(401).json({ success: false, message: 'Your session has expired. Open the app again.' });
    }
  };
}

module.exports = { issueDriverTokens, verifyDriverToken, requireDriver };
