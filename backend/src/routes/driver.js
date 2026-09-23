// Driver-facing API for the Modern Drivers Android app.
//
// Two invariants hold across every route in this file:
//
//  1. The driver id comes from the token. It is never read from a body, a query
//     string or a path parameter, so a driver cannot address another driver's
//     data by editing a request.
//  2. There is no code path here that stops a ride. The stop endpoint exists
//     only to REFUSE and RECORD — see the bottom of this file. Enforcement is
//     server-side, so a patched APK changes nothing.

const router = require('express').Router();
const repo = require('../services/repo');
const { issueDriverTokens, verifyDriverToken, requireDriver } = require('../middleware/driverAuth');
const { registerLimiter, gpsIngestLimiter, writeLimiter } = require('../middleware/rateLimit');
const { isValidId, isBoundedString, isOptionalBoundedString, hasForbiddenKeys } = require('../middleware/validate');
const { normaliseIncomingPoint } = require('../drivers/validation');
const { ALERT } = require('../drivers/alerts');
const tripPlanner = require('../services/tripPlanner');
const { canVisit } = require('../drivers/eligibility');

// Shown in the app before the driver registers, and again on the main
// screen whenever tracking is on. Kept here, server-side, so the wording can be
// corrected without shipping a new APK — and so there is one authoritative copy.
const PRIVACY_NOTICE = {
  version: 1,
  title: 'How Modern Drivers uses your location',
  points: [
    'Your location is recorded only while a ride is running — from the moment you press Start Ride until the office stops it.',
    'It is used to work out the kilometres you travel for Modern Dairy deliveries, and to help the office find you if a delivery goes wrong.',
    'It is not recorded before you start a ride, and it is not recorded after the office stops it.',
    'Only Modern Dairy office staff with a dashboard login can see it.',
    'Android shows a permanent notification on your phone the whole time tracking is on.',
    'Location history is deleted automatically after the retention period set by the office.',
    'You can mark part of your day as personal in the app. Personal stretches are kept out of Modern Dairy business kilometres.',
    'Only the office can stop a ride. If you need it stopped, call the office.',
  ],
};

// POST /driver/register { name, deviceId, appVersion }
//
// The entire sign-in. A name, and the id the app generated for this phone.
router.post('/register', registerLimiter, async (req, res) => {
  const { name, deviceId, appVersion } = req.body || {};
  if (hasForbiddenKeys(req.body)) return res.status(400).json({ success: false, message: 'Invalid request' });
  if (!isBoundedString(name, { min: 1, max: 80 })) {
    return res.status(400).json({ success: false, message: 'Please enter your name.' });
  }
  if (!isValidId(deviceId)) return res.status(400).json({ success: false, message: 'Invalid device id' });

  try {
    const { driver, created } = await repo.registerDriver({ name, deviceId, appVersion });
    const tokens = await issueDriverTokens(driver.id, deviceId);
    const { config } = await repo.getConfig();
    res.json({
      success: true,
      data: {
        driver: { id: driver.id, name: driver.name, driverCode: driver.driverCode },
        ...tokens,
        created,
        tracking: { sampleIntervalSec: config.sampleIntervalSec, maxBatchPoints: config.maxBatchPoints },
        privacyNotice: PRIVACY_NOTICE,
      },
    });
  } catch (e) {
    if (e.code === 'INACTIVE') return res.status(403).json({ success: false, message: e.message });
    throw e;
  }
});

// POST /driver/refresh { refreshToken }
router.post('/refresh', registerLimiter, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!isBoundedString(refreshToken, { min: 1, max: 2000 })) return res.status(400).json({ success: false, message: 'refreshToken is required' });
  try {
    const payload = await verifyDriverToken(refreshToken, 'driver_refresh');
    const driver = await repo.getDriver(payload.sub);
    if (!driver || driver.status !== 'active') return res.status(401).json({ success: false, message: 'This account is not active.' });
    if (driver.deviceId && payload.did && driver.deviceId !== payload.did) {
      return res.status(401).json({ success: false, message: 'This account has been set up on another phone.' });
    }
    const tokens = await issueDriverTokens(driver.id, payload.did);
    res.json({ success: true, data: { accessToken: tokens.accessToken } });
  } catch {
    res.status(401).json({ success: false, message: 'Please enter your name and number again.' });
  }
});

router.use(requireDriver());

// GET /driver/me — everything the app's main screen shows.
router.get('/me', async (req, res) => {
  const { config } = await repo.getConfig();
  const ride = req.driver.activeRideId ? await repo.getRide(req.driver.activeRideId) : null;
  res.json({
    success: true,
    data: {
      driver: {
        id: req.driver.id,
        name: req.driver.name,
        driverCode: req.driver.driverCode,
        vehicleId: req.driver.vehicleId || null,
      },
      ride: ride && ride.status === 'active' ? {
        id: ride.id, startedAt: ride.startedAt, lastPointAt: ride.lastPointAt || null,
        pointCount: ride.pointCount || 0, status: ride.status,
      } : null,
      tracking: { sampleIntervalSec: config.sampleIntervalSec, maxBatchPoints: config.maxBatchPoints },
      privacyNotice: PRIVACY_NOTICE,
      // The app shows this verbatim so the rule is never in doubt on the phone.
      rideControl: 'Only the Modern Dairy office can stop a ride.',
    },
  });
});

// POST /driver/rides/start
// Idempotent: a double tap, a retry after a timeout, or the app restarting all
// return the SAME ride. Duplicate active rides are impossible (transaction in
// repo.startRide).
router.post('/rides/start', writeLimiter, async (req, res) => {
  const { deviceId, appVersion } = req.body || {};
  try {
    const ride = await repo.startRide(req.driverId, { deviceId, appVersion });
    if (!ride.alreadyActive) {
      await repo.writeEvent({ driverId: req.driverId, rideId: ride.rideId, kind: 'ride_started', detail: { deviceId: deviceId || null } });
    }
    res.json({
      success: true,
      data: {
        rideId: ride.rideId,
        startedAt: ride.startedAt,
        alreadyActive: ride.alreadyActive,
        message: ride.alreadyActive ? 'Your ride is already running.' : 'Tracking has started.',
      },
    });
  } catch (e) {
    const status = e.code === 'INACTIVE' ? 403 : e.code === 'NO_DRIVER' ? 404 : 500;
    res.status(status).json({ success: false, message: e.code ? e.message : 'Could not start the ride. Try again.' });
  }
});

// GET /driver/rides/active — the app polls this so the phone learns promptly
// that the office has stopped the ride, and stops the foreground service.
router.get('/rides/active', async (req, res) => {
  const ride = req.driver.activeRideId ? await repo.getRide(req.driver.activeRideId) : null;
  if (!ride || ride.status !== 'active') {
    // Tell the app WHY it should stop, so it can show the driver something
    // truthful instead of silently going dark.
    const last = ride || null;
    return res.json({
      success: true,
      data: {
        active: false,
        stoppedBy: last?.stoppedBy || null,
        stoppedAt: last?.stoppedAt || null,
        reason: last?.stopReason || null,
        kind: last?.stopKind || null,
      },
    });
  }
  res.json({ success: true, data: { active: true, rideId: ride.id, startedAt: ride.startedAt, lastPointAt: ride.lastPointAt || null } });
});

// POST /driver/rides/:rideId/points { points: [...] }
router.post('/rides/:rideId/points', gpsIngestLimiter, async (req, res) => {
  const { rideId } = req.params;
  if (!isValidId(rideId)) return res.status(400).json({ success: false, message: 'Invalid ride id' });
  const body = req.body || {};
  if (!Array.isArray(body.points)) return res.status(400).json({ success: false, message: 'points must be an array' });

  const { config } = await repo.getConfig();
  if (body.points.length > config.maxBatchPoints) {
    return res.status(413).json({ success: false, message: `Send at most ${config.maxBatchPoints} points per batch.` });
  }

  const ride = await repo.getRide(rideId);
  if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
  // The ride must belong to the token's driver. Without this check a driver
  // could post points into a colleague's ride.
  if (ride.driverId !== req.driverId) {
    await repo.writeEvent({ driverId: req.driverId, rideId, kind: 'cross_driver_upload_blocked', detail: { ownedBy: ride.driverId } });
    return res.status(403).json({ success: false, message: 'That ride does not belong to this account.' });
  }
  if (ride.status !== 'active') {
    // Late points for a stopped ride are ACCEPTED if they were recorded before
    // the stop — a phone that was offline when the office stopped the ride
    // still holds real data from the working period — and refused otherwise.
    // Silently dropping them would put a hole in the day's distance.
    const cutoff = ride.stoppedAt || 0;
    const inWindow = body.points.filter((p) => Number(p?.deviceTs) <= cutoff);
    if (!inWindow.length) {
      return res.status(409).json({ success: false, code: 'RIDE_STOPPED', message: 'This ride has been stopped by the office.', data: { stoppedAt: ride.stoppedAt, reason: ride.stopReason } });
    }
    body.points = inWindow;
  }

  const nowMs = Date.now();
  const accepted = [];
  const rejected = [];
  for (const raw of body.points) {
    const { point, error } = normaliseIncomingPoint(raw, { nowMs, clockSkewMin: config.clockSkewMin });
    if (error) { rejected.push({ clientPointId: raw?.clientPointId ?? null, error }); continue; }
    accepted.push(point);
  }

  if (accepted.length) await repo.ingestPoints(rideId, req.driverId, accepted);
  if (rejected.length) {
    await repo.writeEvent({ driverId: req.driverId, rideId, kind: 'points_rejected', detail: { count: rejected.length, sample: rejected.slice(0, 5) } });
  }

  // The app deletes a queued point only when the server confirms it by id, so a
  // partial failure never loses data — it is simply retried.
  res.json({
    success: true,
    data: {
      accepted: accepted.map((p) => p.clientPointId),
      rejected,
      serverTime: nowMs,
      rideActive: ride.status === 'active',
    },
  });
});

// POST /driver/rides/:rideId/declare { kind:'personal', fromTs, toTs, note }
// A driver saying "this stretch was my own Porter work".
//
// This can only ever move kilometres OUT of the business total, never in. That
// asymmetry is the entire reason it is safe to let a driver influence the
// classification at all, and it is why there is no 'business' kind here.
router.post('/rides/:rideId/declare', writeLimiter, async (req, res) => {
  const { rideId } = req.params;
  if (!isValidId(rideId)) return res.status(400).json({ success: false, message: 'Invalid ride id' });
  const { kind, fromTs, toTs, note } = req.body || {};
  if (kind !== 'personal') return res.status(400).json({ success: false, message: 'Only personal trips can be declared from the app.' });
  if (!Number.isFinite(fromTs)) return res.status(400).json({ success: false, message: 'fromTs is required' });
  if (toTs != null && (!Number.isFinite(toTs) || toTs < fromTs)) return res.status(400).json({ success: false, message: 'toTs must be after fromTs' });
  if (!isOptionalBoundedString(note, { max: 300 })) return res.status(400).json({ success: false, message: 'note is too long' });

  const ride = await repo.getRide(rideId);
  if (!ride || ride.driverId !== req.driverId) return res.status(404).json({ success: false, message: 'Ride not found' });

  const ref = await repo.C.declarations().add({
    rideId, driverId: req.driverId, kind: 'personal',
    fromTs, toTs: toTs ?? null, note: note || null,
    declaredAt: Date.now(), declaredBy: `driver:${req.driverId}`,
  });
  await repo.writeEvent({ driverId: req.driverId, rideId, kind: 'personal_declared', detail: { fromTs, toTs: toTs ?? null } });
  res.json({ success: true, data: { id: ref.id } });
});

// POST /driver/health — permission/GPS/battery state from the phone.
// This is what lets the dashboard say "this driver's GPS permission was revoked"
// rather than just "no data".
router.post('/health', writeLimiter, async (req, res) => {
  const b = req.body || {};
  const detail = {
    locationPermission: typeof b.locationPermission === 'string' ? b.locationPermission.slice(0, 32) : null,
    backgroundPermission: typeof b.backgroundPermission === 'string' ? b.backgroundPermission.slice(0, 32) : null,
    gpsEnabled: typeof b.gpsEnabled === 'boolean' ? b.gpsEnabled : null,
    batteryOptimised: typeof b.batteryOptimised === 'boolean' ? b.batteryOptimised : null,
    online: typeof b.online === 'boolean' ? b.online : null,
    queuedPoints: Number.isFinite(b.queuedPoints) ? b.queuedPoints : null,
    appVersion: typeof b.appVersion === 'string' ? b.appVersion.slice(0, 32) : null,
  };
  await repo.writeEvent({ driverId: req.driverId, rideId: req.driver.activeRideId || null, kind: 'health', detail });

  const degraded = detail.locationPermission === 'denied' || detail.gpsEnabled === false;
  if (degraded && req.driver.activeRideId) {
    await repo.raiseAlertOnce({
      key: `${ALERT.PERMISSION_LOST}|${req.driverId}|`,
      kind: ALERT.PERMISSION_LOST,
      severity: 'warn',
      driverId: req.driverId,
      rideId: req.driver.activeRideId,
      detail: detail.gpsEnabled === false
        ? 'Driver has GPS switched off during an active ride.'
        : 'Driver has revoked location permission during an active ride.',
    }).catch(() => {});
  }
  res.json({ success: true, data: { received: true } });
});

// POST /driver/rides/:rideId/stop — ALWAYS REFUSED.
//
// This endpoint exists so that an attempt is recorded rather than merely
// bouncing off a missing route. The restriction is enforced here, on the
// server: no version of the app, patched or otherwise, can stop a ride.
router.post('/rides/:rideId/stop', async (req, res) => {
  const { rideId } = req.params;
  await repo.writeEvent({
    driverId: req.driverId,
    rideId: isValidId(rideId) ? rideId : null,
    kind: 'unauthorized_ride_control',
    detail: { ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) },
  });
  await repo.raiseAlertOnce({
    key: `${ALERT.UNAUTHORIZED_RIDE_CONTROL}|${req.driverId}|${rideId}`,
    kind: ALERT.UNAUTHORIZED_RIDE_CONTROL,
    severity: 'warn',
    driverId: req.driverId,
    rideId: isValidId(rideId) ? rideId : null,
    detail: 'An attempt was made to stop a ride from the driver app.',
  }).catch(() => {});
  res.status(403).json({
    success: false,
    code: 'RIDE_STOP_NOT_PERMITTED',
    message: 'Only the Modern Dairy office can stop a ride. Please call the office.',
  });
});

// ---------------------------------------------------------------------------
// Planning a round
// ---------------------------------------------------------------------------

// GET /driver/stops — the restaurants a driver can pick from.
//
// Only ones with a confirmed location: a restaurant the office has not placed
// yet cannot be routed to, and offering it would produce a plan that quietly
// skipped a stop. The driver's own recent stops come first, because after a
// week that is almost always what they are reaching for.
router.get('/stops', async (req, res) => {
  const [{ restaurants }, own] = await Promise.all([
    repo.loadPlaces(),
    repo.loadDriverLegs(req.driverId),
  ]);

  const lastSeen = new Map();
  for (const s of own.sequences || []) {
    for (const id of s.order || []) {
      if (!lastSeen.has(id)) lastSeen.set(id, s.at || 0);
    }
  }

  const stops = restaurants
    // The same test the planner applies, so the list and the plan can never
    // disagree about where a driver may be sent.
    .filter(canVisit)
    .map((p) => ({
      id: p.id,
      name: p.name,
      area: p.area || null,
      lastVisitedAt: lastSeen.get(p.id) || null,
    }))
    .sort((a, b) => (b.lastVisitedAt || 0) - (a.lastVisitedAt || 0)
      || String(a.name).localeCompare(String(b.name)));

  res.json({ success: true, data: { stops, recentCount: lastSeen.size } });
});

// POST /driver/plan { stopIds, from: { lat, lng }, returnToStart }
//
// The order to visit them in. What makes this worth having is not the ordering
// — three stops is six possibilities, and any computer can try all six — but
// that the distances are this driver's own, learned from their past rides, so
// the answer reflects the roads they actually use rather than the ones a map
// would pick for a stranger.
router.post('/plan', writeLimiter, async (req, res) => {
  const body = req.body || {};
  if (hasForbiddenKeys(body)) return res.status(400).json({ success: false, message: 'Bad request' });

  const stopIds = [...new Set(
    (Array.isArray(body.stopIds) ? body.stopIds : []).filter(isValidId),
  )].slice(0, 12);
  if (stopIds.length < 2) {
    return res.status(400).json({ success: false, message: 'Pick at least two restaurants.' });
  }

  // Where the driver is now. Without it there is no "first stop", only a loop
  // with no beginning, so this is a refusal rather than a guess at the depot.
  const lat = Number(body.from && body.from.lat);
  const lng = Number(body.from && body.from.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({
      success: false,
      code: 'NO_START_LOCATION',
      message: 'Your current location is needed to work out which stop comes first.',
    });
  }

  try {
    const plan = await tripPlanner.planTrip(req.driverId, {
      start: { id: '__start__', name: 'Where you are now', lat, lng },
      stopIds,
      returnTo: body.returnToStart ? '__start__' : null,
    });
    if (plan.error) return res.status(400).json({ success: false, message: plan.error, data: plan });
    return res.json({ success: true, data: plan });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'The route could not be worked out just now.' });
  }
});

module.exports = { router, PRIVACY_NOTICE };
