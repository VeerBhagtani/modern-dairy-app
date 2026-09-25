// Admin API for the office dashboard. Mounted at /admin, behind requireAdmin().
//
// Role model on top of requireAdmin():
//   admin    everything, including config, driver accounts and deletion
//   manager  view + review classifications + stop rides
//   viewer   read only
//
// Roles come from the admin's own account (admins/{username}) and ride on the
// signed token, so a role change takes effect at the next sign-in.

const { asyncRouter } = require('../middleware/asyncRoutes');
// Every handler's errors reach index.js's error handler; see asyncRoutes.js.
const router = asyncRouter(require('express').Router());
const { depotCheck } = require('../services/depotCheck');
const repo = require('../services/repo');
const { db, FieldValue } = require('../services/firestore');
const { writeLimiter, batchLimiter } = require('../middleware/rateLimit');
const bcrypt = require('bcryptjs');
const { verifyLogin, issueAdminToken, forgetAdmin } = require('../middleware/adminAuth');
const { placeIdFor } = require('../services/placeKey');
const geocode = require('../services/geocode');
const mobileVendor = require('../drivers/mobileVendor');
const placesApi = require('../services/places');
const locationAudit = require('../services/locationAudit');
const { pinChange, pinRemoval } = require('../services/pinHistory');
const maintenance = require('../services/maintenance');
const { getSecret, setSecret, secretStatus, KNOWN_SECRETS } = require('../services/secretManager');
const {
  isValidId, isBoundedString, isOptionalBoundedString, pickAllowed, hasForbiddenKeys,
} = require('../middleware/validate');
const { aggregateRides } = require('../drivers/pipeline');
const { SEGMENT_TYPE } = require('../drivers/classification');
const reports = require('../drivers/reports');
const orderSource = require('../services/orderSource');
const manual = require('../services/orderSource/manual');
// Calculating rides, closing finished days, keeping kilometres current:
// shared with the drivers' own history. See services/rideProcessing.js and
// services/freshness.js.
const { processOne, bringUpToDate, housekeeping } = require('../services/rideProcessing');
const { driverHistory } = require('../services/history');
const { buildReplay } = require('../services/replay');

// The role was established at sign-in and is carried in the admin token, which
// requireAdmin() has already verified, so this is a comparison rather than a
// database read on every request.
const RANK = { viewer: 1, manager: 2, admin: 3 };

function requireRole(min) {
  return (req, res, next) => {
    if ((RANK[req.adminRole] || 0) < RANK[min]) {
      return res.status(403).json({ success: false, message: `This action needs the ${min} role.` });
    }
    next();
  };
}

const bad = (res, message) => res.status(400).json({ success: false, message });

router.use((req, res, next) => {
  if (hasForbiddenKeys(req.body)) return bad(res, 'Invalid request body');
  next();
});

// ---------------------------------------------------------------------------
// Your own password
// ---------------------------------------------------------------------------

// POST /admin/password { currentPassword, newPassword }
//
// Registered before the routes that take a :driverId so a literal path can
// never be read as an id. Any signed-in role may change their own password and
// only their own: the account is taken from the verified token, never from the
// request body, so this cannot be pointed at somebody else's login.
//
// The current password is required even though the caller already holds a
// valid token. A token left open on an office PC should not be enough to lock
// the real owner out.
router.post('/password', writeLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return bad(res, 'Use at least 10 characters. This account can see where every driver is.');
  }
  if (typeof currentPassword !== 'string' || !currentPassword) {
    return bad(res, 'Enter your current password.');
  }
  const ok = await verifyLogin(req.adminId, currentPassword);
  if (!ok) return res.status(401).json({ success: false, message: 'That is not your current password.' });
  if (newPassword === currentPassword) return bad(res, 'Choose a password different from the current one.');

  await db.collection('admins').doc(req.adminId).set({
    passwordHash: await bcrypt.hash(newPassword, 12),
    mustChangePassword: false,
    updatedAt: Date.now(),
    // Every token issued before this moment stops working (requireAdmin), so
    // a changed password also signs out anyone holding the old one.
    passwordChangedAt: Date.now(),
  }, { merge: true });
  forgetAdmin(req.adminId);
  const fresh = await issueAdminToken(req.adminId, req.adminRole);

  await repo.writeAudit({ adminId: req.adminId, action: 'admin.password_changed' });
  // A new token for this session, so the person who changed it stays in.
  res.json({ success: true, data: { changed: true, token: fresh } });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// GET /admin/dashboard — the fleet list plus today's headline numbers.
// Everything it reports about "live" carries the age of the position, and the
// client is told the stale threshold rather than guessing one: an old fix must
// never be painted as a live one.
router.get('/dashboard', requireRole('viewer'), async (req, res) => {
  const { config } = await repo.getConfig();
  const now = Date.now();
  const today = repo.dayKeyFor(now);

  await housekeeping(now);
  const [drivers, todays, running, liveSnap, alerts] = await Promise.all([
    repo.listDrivers({ includeInactive: true }),
    repo.listRides({ from: Date.parse(`${today}T00:00:00+05:30`), limit: 500 }),
    // A ride still running from an earlier day is today's work too. Listing
    // only rides that STARTED today hid every driver whose ride nobody had
    // stopped: their points arrived, and the dashboard showed nothing.
    repo.activeRides(),
    repo.C.live().get(),
    repo.openAlerts(),
  ]);
  // Rides are one per day. A running ride from an earlier day is closed at the
  // end of its day right here — housekeeping only runs every few minutes — and
  // then calculated like any finished ride, but it is not TODAY's: today's
  // figures count today's rides only. Adding it in reported yesterday
  // afternoon's kilometres as this morning's.
  const seen = new Set(todays.map((r) => r.id));
  const earlier = running.filter((r) => !seen.has(r.id));
  for (const r of earlier) {
    // eslint-disable-next-line no-await-in-loop
    await repo.closeIfDayOver(r, now);
  }
  const rides = todays;
  const calculation = await bringUpToDate(todays.concat(earlier));
  const live = new Map(liveSnap.docs.map((d) => [d.id, d.data()]));
  const ridesByDriver = new Map();
  for (const r of rides) {
    if (!ridesByDriver.has(r.driverId)) ridesByDriver.set(r.driverId, []);
    ridesByDriver.get(r.driverId).push(r);
  }

  // Today's processed results, where they exist. A ride that has not been
  // processed yet reports nulls, not zeros — "not calculated" and "zero
  // kilometres" are different facts and must not look the same.
  const processed = await Promise.all(rides.map(async (r) => ({ ride: r, result: await repo.loadProcessing(r.id, { withSegments: false }) })));
  const resultByRide = new Map(processed.map((p) => [p.ride.id, p.result]));

  const rows = drivers.map((d) => {
    const l = live.get(d.id) || null;
    const ageSec = l ? Math.round((now - l.deviceTs) / 1000) : null;
    const driverRides = ridesByDriver.get(d.id) || [];
    const active = driverRides.find((r) => r.status === 'active') || null;
    let verified = null; let total = null; let unknown = null; let calculated = false;
    let business = null; let personal = null;
    for (const r of driverRides) {
      const res2 = resultByRide.get(r.id);
      if (!res2) continue;
      calculated = true;
      verified = (verified || 0) + res2.distance.metres.verifiedBusiness;
      business = (business || 0) + res2.distance.metres.verifiedBusiness + res2.distance.metres.likelyBusiness;
      personal = (personal || 0) + res2.distance.metres.personal;
      total = (total || 0) + res2.distance.metres.dayTotal;
      unknown = (unknown || 0) + res2.distance.metres.unknown;
    }
    return {
      driverId: d.id,
      name: d.name,
      driverCode: d.driverCode,
      status: d.status,
      vehicleId: d.vehicleId || null,
      rideStatus: active ? 'active' : (driverRides.length ? 'finished' : 'not_started'),
      rideId: active?.id || null,
      rideStartedAt: active?.startedAt || null,
      // The round the driver named when planning ("Camp round"), if any.
      roundName: active?.roundName || null,
      lastLocation: l ? { lat: l.lat, lng: l.lng, accuracyM: l.accuracyM ?? null } : null,
      lastUpdateAt: l?.deviceTs || null,
      lastUpdateAgeSec: ageSec,
      // Three distinct states, never collapsed into "online".
      locationState: !l ? 'unavailable' : (ageSec <= config.staleLocationSec ? 'live' : 'stale'),
      trackingHealth: !active ? 'idle'
        : (!l || ageSec > config.gpsMissingAlertMin * 60) ? 'no_signal'
          : (ageSec > config.staleLocationSec ? 'degraded' : 'ok'),
      today: {
        calculated,
        totalKm: total == null ? null : Math.round(total / 100) / 10,
        verifiedBusinessKm: verified == null ? null : Math.round(verified / 100) / 10,
        businessKm: business == null ? null : Math.round(business / 100) / 10,
        personalKm: personal == null ? null : Math.round(personal / 100) / 10,
        unknownKm: unknown == null ? null : Math.round(unknown / 100) / 10,
      },
    };
  });

  res.json({
    success: true,
    data: {
      serverTime: now,
      staleAfterSec: config.staleLocationSec,
      // What this request calculated, and what it left for the next one.
      calculation: { calculated: calculation.calculated.length, deferred: calculation.deferred, failed: calculation.failed },
      drivers: rows,
      metrics: {
        activeDrivers: rows.filter((r) => r.rideStatus === 'active').length,
        completedRides: rides.filter((r) => r.status !== 'active').length,
        totalKm: Math.round(rows.reduce((s, r) => s + (r.today.totalKm || 0), 0) * 10) / 10,
        verifiedBusinessKm: Math.round(rows.reduce((s, r) => s + (r.today.verifiedBusinessKm || 0), 0) * 10) / 10,
        businessKm: Math.round(rows.reduce((s, r) => s + (r.today.businessKm || 0), 0) * 10) / 10,
        personalKm: Math.round(rows.reduce((s, r) => s + (r.today.personalKm || 0), 0) * 10) / 10,
        unknownKm: Math.round(rows.reduce((s, r) => s + (r.today.unknownKm || 0), 0) * 10) / 10,
        trackingIssues: rows.filter((r) => ['no_signal', 'degraded'].includes(r.trackingHealth)).length,
        openAlerts: alerts.length,
        unprocessedRides: rides.filter((r) => r.status !== 'active' && !resultByRide.get(r.id)).length,
      },
      alerts: alerts.slice(0, 50),
      // Cached with the places the engine uses, so this costs no extra read.
      depot: depotCheck((await repo.loadPlaces()).facilities),
    },
  });
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

router.get('/list', requireRole('viewer'), async (req, res) => {
  res.json({ success: true, data: await repo.listDrivers({ includeInactive: req.query.all === '1' }) });
});

// Drivers are not created here — they register themselves in the app by
// typing their name, and appear in this list the moment they do.
// The office's job is to check the list and deactivate anyone who should not
// be on it, which is one action instead of forty.

router.patch('/:driverId', requireRole('admin'), writeLimiter, async (req, res) => {
  const { driverId } = req.params;
  if (!isValidId(driverId)) return bad(res, 'Invalid driver id');
  // Mass-assignment guard: status, deviceId and activeRideId are NOT
  // in this list, so no request body can flip them.
  const patch = pickAllowed(req.body, ['name', 'phone', 'vehicleId', 'notes']);
  if (patch.name !== undefined && !isBoundedString(patch.name, { min: 1, max: 80 })) return bad(res, 'name is invalid');
  if (patch.notes !== undefined && !isOptionalBoundedString(patch.notes, { max: 500 })) return bad(res, 'notes is too long');
  const updated = await repo.updateDriver(driverId, patch, req.adminId);
  if (!updated) return res.status(404).json({ success: false, message: 'Driver not found' });
  res.json({ success: true, data: updated });
});

// Deactivate rather than delete: the rides, distances and audit trail of a
// driver who has left must survive them leaving.
router.post('/:driverId/status', requireRole('admin'), writeLimiter, async (req, res) => {
  const { driverId } = req.params;
  const { status } = req.body || {};
  if (!isValidId(driverId)) return bad(res, 'Invalid driver id');
  if (!['active', 'inactive'].includes(status)) return bad(res, 'status must be active or inactive');
  const driver = await repo.getDriver(driverId);
  if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
  if (status === 'inactive' && driver.activeRideId) {
    return res.status(409).json({ success: false, message: 'Stop this driver\'s active ride before deactivating the account.' });
  }
  const updated = await repo.updateDriver(driverId, { status, deactivatedAt: status === 'inactive' ? Date.now() : null }, req.adminId);
  res.json({ success: true, data: updated });
});

// ---------------------------------------------------------------------------
// Rides
// ---------------------------------------------------------------------------

router.get('/rides', requireRole('viewer'), async (req, res) => {
  const { driverId, from, to, status } = req.query;
  if (driverId && !isValidId(driverId)) return bad(res, 'Invalid driver id');
  const rides = await repo.listRides({
    driverId: driverId || undefined,
    status: status || undefined,
    from: from ? Number(from) : undefined,
    to: to ? Number(to) : undefined,
  });
  res.json({ success: true, data: rides });
});

router.get('/rides/active', requireRole('viewer'), async (req, res) => {
  res.json({ success: true, data: await repo.activeRides() });
});

// The ride detail the individual-driver view is built from: the ride, its
// processed result with segments, and (optionally) the raw points for replay.
router.get('/rides/:rideId', requireRole('viewer'), async (req, res) => {
  const { rideId } = req.params;
  if (!isValidId(rideId)) return bad(res, 'Invalid ride id');
  let ride = await repo.getRide(rideId);
  if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
  // Opening a ride shows its kilometres as of now, not as of whenever it was
  // last calculated.
  const fresh = await bringUpToDate([{ id: rideId, ...ride }], { maxRides: 1 });
  if (fresh.calculated.length) ride = await repo.getRide(rideId);
  const wantPoints = req.query.points === '1' || req.query.points === 'raw';
  const [processing, points, declarations, reviews] = await Promise.all([
    repo.loadProcessing(rideId),
    wantPoints ? repo.loadPoints(rideId) : Promise.resolve(null),
    repo.declarationsForRide(rideId),
    repo.reviewsForRide(rideId),
  ]);
  res.json({
    success: true,
    data: {
      ride,
      processing,
      // The replay: every fix, with whether it counted and what the stretch
      // ending at it counted as, straight from the same track cleaning the
      // kilometres came from.
      replay: points ? buildReplay(points, processing) : null,
      // Raw points, exactly as uploaded, only when asked for by name.
      points: req.query.points === 'raw' ? points : null,
      declarations,
      reviews,
      processingNote: processing ? null
        : ride.processedResultDeletedAt
          ? `The detailed result was deleted under the ${ride.processedRetentionDays || ''}-day retention policy; the day's totals are kept on the ride.`
          : 'This ride has not been processed yet. No distance has been calculated.',
    },
  });
});

// THE remote stop. A reason is mandatory — an unexplained stop in a location
// log is exactly the kind of record that cannot be defended later.
router.post('/rides/:rideId/stop', requireRole('manager'), writeLimiter, async (req, res) => {
  const { rideId } = req.params;
  const { reason, emergency, stoppedByName } = req.body || {};
  if (!isValidId(rideId)) return bad(res, 'Invalid ride id');
  if (!isBoundedString(reason, { min: 3, max: 300 })) return bad(res, 'Give a reason for stopping this ride (at least 3 characters).');
  // Who stopped it: one of the office's names. Checked against the list so a
  // typo cannot become a new "person" in the audit log.
  let byName = null;
  if (stoppedByName != null && stoppedByName !== '') {
    const names = await repo.getStopNames();
    byName = names.find((n) => n.toLowerCase() === String(stoppedByName).trim().toLowerCase()) || null;
    if (!byName) return bad(res, 'Choose who is stopping this ride from the list, or add their name first.');
  }
  try {
    const out = await repo.stopRide(rideId, {
      by: `admin:${req.adminId}`,
      byName,
      reason: emergency === true ? `EMERGENCY STOP: ${reason}` : reason,
      kind: emergency === true ? 'emergency' : 'admin',
    });
    // Mark the live document so the map stops showing an active marker even
    // before the phone next checks in.
    await repo.C.live().doc(out.driverId).set({ rideStatus: 'stopped', rideStoppedAt: Date.now() }, { merge: true }).catch(() => {});
    // A stopped ride is complete: calculate it now, so its kilometres are
    // there the moment anybody looks. Never allowed to fail the stop itself.
    try { await processOne(rideId, { waitMs: 10000 }); } catch (err) {
      await repo.writeEvent({ driverId: out.driverId, rideId, kind: 'processing_failed', detail: { error: String(err.message || err).slice(0, 200) } }).catch(() => {});
    }
    res.json({ success: true, data: out });
  } catch (e) {
    if (e.code === 'NO_RIDE') return res.status(404).json({ success: false, message: 'Ride not found' });
    throw e;
  }
});

// The names offered as "stopped by" when a ride is stopped.
router.get('/stop-names', requireRole('viewer'), async (req, res) => {
  res.json({ success: true, data: { names: await repo.getStopNames() } });
});
router.post('/stop-names', requireRole('manager'), writeLimiter, async (req, res) => {
  try {
    res.json({ success: true, data: { names: await repo.addStopName((req.body || {}).name, req.adminId) } });
  } catch (e) {
    if (e.code === 'BAD_NAME' || e.code === 'FULL') return bad(res, e.message);
    throw e;
  }
});
router.delete('/stop-names', requireRole('manager'), writeLimiter, async (req, res) => {
  res.json({ success: true, data: { names: await repo.removeStopName((req.body || {}).name, req.adminId) } });
});

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

// processOne lives in services/rideProcessing.js.

// GET /admin/history?driverId=&from=&to= — one driver's days, newest first.
//
// A ride is a day (rides close with their day), so this is the driver's
// working history: each day's business and personal kilometres and the
// restaurants reached. Opening a day uses the ride view.
router.get('/history', requireRole('viewer'), async (req, res) => {
  const { driverId } = req.query;
  if (!isValidId(driverId)) return bad(res, 'Choose a driver.');
  const to = Number(req.query.to) || Date.now();
  const from = Number(req.query.from) || to - 31 * 24 * 3600 * 1000;
  if (to < from) return bad(res, '"From" is after "to".');
  if (to - from > 190 * 24 * 3600 * 1000) return bad(res, 'Show at most six months at a time.');
  const driver = await repo.getDriver(driverId);
  if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });
  const history = await driverHistory({ driverId, from, to, maxRides: 200 });
  res.json({ success: true, data: { driver: { id: driverId, name: driver.name, driverCode: driver.driverCode }, from, to, ...history } });
});

router.post('/rides/:rideId/process', requireRole('manager'), writeLimiter, async (req, res) => {
  const { rideId } = req.params;
  if (!isValidId(rideId)) return bad(res, 'Invalid ride id');
  try {
    const result = await processOne(rideId, { waitMs: 15000 });
    await repo.writeAudit({ adminId: req.adminId, action: 'ride.reprocess', target: rideId, after: { calcVersion: result.calcVersion, verifiedBusinessKm: result.distance.km.verifiedBusiness } });
    res.json({ success: true, data: result });
  } catch (e) {
    if (e.code === 'NO_RIDE') return res.status(404).json({ success: false, message: 'Ride not found' });
    if (e.code === 'BUSY') return res.status(409).json({ success: false, message: e.message });
    if (e.code === 'NO_RAW') return res.status(409).json({ success: false, message: e.message });
    throw e;
  }
});

// Bulk recalculation — what you run after changing a threshold.
router.post('/process-range', requireRole('admin'), writeLimiter, async (req, res) => {
  const { from, to, driverId } = req.body || {};
  if (!Number.isFinite(from) || !Number.isFinite(to)) return bad(res, 'from and to (epoch ms) are required');
  if (to - from > 62 * 24 * 3600 * 1000) return bad(res, 'Process at most 62 days at a time.');
  const rides = await repo.listRides({ from, to, driverId: driverId || undefined, limit: 500 });
  const done = []; const failed = [];
  for (const r of rides) {
    if (r.status === 'active') continue; // an unfinished ride would be reprocessed again anyway
    try { /* eslint-disable-next-line no-await-in-loop */ await processOne(r.id); done.push(r.id); }
    catch (e) { failed.push({ rideId: r.id, error: e.message }); }
  }
  await repo.writeAudit({ adminId: req.adminId, action: 'ride.reprocess_range', target: `${from}-${to}`, after: { processed: done.length, failed: failed.length } });
  res.json({ success: true, data: { processed: done.length, failed } });
});

// ---------------------------------------------------------------------------
// Review workflow
// ---------------------------------------------------------------------------

router.get('/review/queue', requireRole('viewer'), async (req, res) => {
  const from = req.query.from ? Number(req.query.from) : Date.now() - 14 * 24 * 3600 * 1000;
  const rides = await repo.listRides({ from, limit: 300 });
  const out = [];
  for (const ride of rides) {
    /* eslint-disable-next-line no-await-in-loop */
    const p = await repo.loadProcessing(ride.id);
    if (!p) continue;
    for (const seg of p.segments.filter((s) => s.needsReview)) {
      out.push({
        rideId: ride.id, dayKey: ride.dayKey, driverId: ride.driverId, driverName: ride.driverName,
        segmentId: seg.id, type: seg.type, confidence: seg.confidence,
        distanceM: seg.distanceM, gapEstimateM: seg.gapEstimateM,
        startTs: seg.startTs, endTs: seg.endTs,
        place: seg.place, nearbyPlaces: seg.nearbyPlaces, ambiguousPlaces: seg.ambiguousPlaces,
        evidence: seg.evidence,
      });
    }
  }
  out.sort((a, b) => b.distanceM - a.distanceM);
  res.json({ success: true, data: { pending: out.length, segments: out.slice(0, 500) } });
});

const REVIEWABLE_TYPES = [
  SEGMENT_TYPE.BUSINESS_TRAVEL,
  SEGMENT_TYPE.TRAVEL_BETWEEN_BUSINESS_LOCATIONS,
  SEGMENT_TYPE.LIKELY_RESTAURANT_VISIT,
  SEGMENT_TYPE.MODERN_DAIRY_DEPARTURE,
  SEGMENT_TYPE.RETURN_TO_MODERN_DAIRY,
  SEGMENT_TYPE.PERSONAL_OR_NON_BUSINESS,
  SEGMENT_TYPE.UNKNOWN,
];

// A review NEVER edits the original classification and NEVER touches raw GPS.
// It appends a decision; the ride is then reprocessed so the decision flows
// through the distance buckets with a full audit trail behind it.
router.post('/rides/:rideId/segments/:segmentId/review', requireRole('manager'), writeLimiter, async (req, res) => {
  const { rideId, segmentId } = req.params;
  const { toType, note } = req.body || {};
  if (!isValidId(rideId) || !isValidId(segmentId)) return bad(res, 'Invalid ids');
  if (!REVIEWABLE_TYPES.includes(toType)) return bad(res, `toType must be one of: ${REVIEWABLE_TYPES.join(', ')}`);
  if (!isOptionalBoundedString(note, { max: 500 })) return bad(res, 'note is too long');

  const processing = await repo.loadProcessing(rideId);
  if (!processing) return res.status(404).json({ success: false, message: 'This ride has not been processed yet.' });
  const seg = processing.segments.find((s) => s.id === segmentId);
  if (!seg) return res.status(404).json({ success: false, message: 'Segment not found' });

  await repo.addReview({
    rideId, segmentId,
    fromType: seg.type, toType,
    distanceM: seg.distanceM,
    segStartTs: seg.startTs, segEndTs: seg.endTs,
    note, reviewerId: `admin:${req.adminId}`,
  });
  // The office is waiting to see its decision take effect: wait for any
  // calculation already running on this ride rather than failing.
  const result = await processOne(rideId, { waitMs: 15000 });
  res.json({ success: true, data: { distance: result.distance, segment: result.segments.find((s) => s.id === segmentId) } });
});

router.post('/reviews/:reviewId/revert', requireRole('manager'), writeLimiter, async (req, res) => {
  const { reviewId } = req.params;
  if (!isValidId(reviewId)) return bad(res, 'Invalid review id');
  const doc = await repo.C.reviews().doc(reviewId).get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Review not found' });
  await repo.revertReview(reviewId, `admin:${req.adminId}`);
  const result = await processOne(doc.data().rideId, { waitMs: 15000 });
  res.json({ success: true, data: { distance: result.distance } });
});

// ---------------------------------------------------------------------------
// Places: restaurants and Modern Dairy facilities
// ---------------------------------------------------------------------------

function validatePlace(body, { isFacility }) {
  const p = pickAllowed(body, ['name', 'customerId', 'address', 'lat', 'lng', 'radiusM', 'active', 'area', 'schedule', 'externalId', 'isStartPoint', 'notes', 'supplyHold', 'holdReason']);
  if (!isBoundedString(p.name, { min: 1, max: 150 })) return { error: 'A name is required' };
  if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) return { error: 'A valid latitude is required' };
  if (!Number.isFinite(p.lng) || p.lng < -180 || p.lng > 180) return { error: 'A valid longitude is required' };
  if (p.radiusM != null && (!Number.isFinite(p.radiusM) || p.radiusM < 20 || p.radiusM > 5000)) return { error: 'radiusM must be between 20 and 5000 metres' };
  if (!isOptionalBoundedString(p.address, { max: 400 })) return { error: 'address is too long' };
  if (!isFacility && p.customerId != null && !isBoundedString(String(p.customerId), { min: 1, max: 64 })) return { error: 'customerId is invalid' };
  if (!isOptionalBoundedString(p.area, { max: 100 })) return { error: 'area is too long' };
  if (!isOptionalBoundedString(p.externalId, { max: 100 })) return { error: 'externalId is too long' };
  return { place: { ...p, active: p.active !== false } };
}

for (const [path, colName, isFacility] of [['restaurants', 'restaurants', false], ['facilities', 'facilities', true]]) {
  router.get(`/${path}`, requireRole('viewer'), async (req, res) => {
    const snap = await repo.C[colName]().get();
    res.json({ success: true, data: snap.docs.map((d) => {
      const row = { id: d.id, ...d.data() };
      // Whether the location audit still describes this row — decided here,
      // with the server's own rule, so the screen never disagrees with it.
      if (!isFacility && row.locationAudit) row.auditCurrent = !locationAudit.isStale(row);
      return row;
    }) });
  });

  router.post(`/${path}`, requireRole('admin'), writeLimiter, async (req, res) => {
    const { place, error } = validatePlace(req.body || {}, { isFacility });
    if (error) return bad(res, error);
    const ref = repo.C[colName]().doc();
    const { fields, entry } = pinChange(null, { lat: place.lat, lng: place.lng, source: 'office', by: `admin:${req.adminId}`, reason: 'Created by the office.' });
    await ref.set({ ...place, ...fields, createdAt: Date.now(), createdBy: req.adminId, locationHistory: [entry] });
    repo.invalidatePlaceCache();
    await repo.writeAudit({ adminId: req.adminId, action: `${path}.create`, target: ref.id, after: place });
    res.json({ success: true, data: { id: ref.id, ...place } });
  });

  router.patch(`/${path}/:id`, requireRole('admin'), writeLimiter, async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return bad(res, 'Invalid id');
    const ref = repo.C[colName]().doc(id);
    const before = await ref.get();
    if (!before.exists) return res.status(404).json({ success: false, message: 'Not found' });
    const merged = { ...before.data(), ...(req.body || {}) };
    const { place, error } = validatePlace(merged, { isFacility });
    if (error) return bad(res, error);
    // A moved pin goes through the same trail as every other move.
    const old = before.data();
    const moved = place.lat !== old.lat || place.lng !== old.lng;
    let pin = {};
    if (moved) {
      const { fields, entry } = pinChange(old, {
        lat: place.lat, lng: place.lng, source: 'office', by: `admin:${req.adminId}`,
        reason: isBoundedString(req.body?.reason, { min: 3, max: 300 }) ? req.body.reason.trim() : 'Edited by the office.',
      });
      pin = { ...fields, locationHistory: FieldValue.arrayUnion(entry) };
    }
    const { lat: _lat, lng: _lng, ...rest } = place;
    await ref.set({ ...rest, ...pin, updatedAt: Date.now(), updatedBy: req.adminId }, { merge: true });
    repo.invalidatePlaceCache();
    await repo.writeAudit({ adminId: req.adminId, action: `${path}.update`, target: id, before: before.data(), after: place });
    res.json({ success: true, data: { id, ...place } });
  });
}

// CSV import for restaurants. Rows that cannot be trusted are REPORTED, never
// guessed at: a restaurant imported to the wrong coordinates silently poisons
// every classification that touches it.
// POST /admin/restaurants/import { csv }
//
// The real file has a name and an area and nothing else — no coordinates, no
// ids — and it gets uploaded again every time a restaurant is added. Two
// things follow.
//
// First, lat/lng are optional. A row without them is stored as "pending": it
// exists, it is listed, and it is invisible to the classification engine until
// it has a location somebody trusts. A restaurant with no known position must
// never silently become a geofence.
//
// Second, every row gets a stable id derived from its name and area, so the
// second upload of the same file updates the same thousand rows instead of
// creating a second thousand. And an existing row's coordinates are never
// touched: once the office has placed or corrected a pin, re-importing the
// spreadsheet must not undo that work.
router.post('/restaurants/import', requireRole('admin'), writeLimiter, async (req, res) => {
  if (await refuseIfLocked(req, res)) return;
  const { csv } = req.body || {};
  if (!isBoundedString(csv, { min: 1, max: 2_000_000 })) return bad(res, 'csv is required');
  const rows = manual.parseCsv(csv);
  if (rows.length < 2) return bad(res, 'The file has no data rows.');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  // The office's own export calls these "Customer Name" and "Address", and
  // asking someone to rename columns before every upload is how an import stops
  // being used. The aliases are here so their file works untouched.
  const ALIASES = {
    name: ['name', 'customer_name', 'customer', 'restaurant', 'restaurant_name', 'shop_name'],
    address: ['address', 'customer_address', 'full_address'],
    area: ['area', 'locality', 'route'],
    customer_id: ['customer_id', 'code', 'customer_code'],
    external_id: ['external_id', 'id'],
    phone: ['phone', 'mobile', 'phone_number', 'mobile_number', 'mobile_no', 'contact', 'contact_no', 'contact_number'],
  };
  const col = (n) => {
    for (const alias of (ALIASES[n] || [n])) {
      const i = header.indexOf(alias);
      if (i !== -1) return i;
    }
    return -1;
  };
  if (col('name') === -1) return bad(res, 'Missing a name column (accepted: name, customer_name, restaurant)');

  const known = (await repo.C.restaurants().select('lat', 'lng').get()).docs;
  const existing = new Set(known.map((d) => d.id));
  // Rows that already have a pin. Re-importing the spreadsheet — an old copy
  // included — must never move a pin somebody placed, verified or corrected.
  const existingPin = new Set(known.filter((d) => Number.isFinite(d.get('lat')) && Number.isFinite(d.get('lng'))).map((d) => d.id));

  const added = []; const updated = []; const problems = [];
  // Food trucks, kept out of the location machinery. Reported back so the
  // office sees they were recognised rather than wondering where they went.
  let mobileCount = 0;
  const seen = new Map();
  const writer = db.bulkWriter();

  for (let r = 1; r < rows.length; r += 1) {
    const at = (n) => (col(n) === -1 ? null : (rows[r][col(n)] ?? '').trim());
    const name = at('name');
    if (!name) continue;                      // blank line at the end of a file
    const area = at('area') || null;
    const hasCoords = at('lat') && at('lng');

    const base = {
      name,
      customerId: at('customer_id') || null,
      address: at('address') || null,
      phone: at('phone') || null,
      radiusM: at('radius_m') ? Number(at('radius_m')) : null,
      area,
      externalId: at('external_id') || null,
      schedule: at('schedule') || null,
      active: at('active') ? !/^(0|no|false|inactive)$/i.test(at('active')) : true,
    };

    const id = placeIdFor({ externalId: base.externalId, name, area });
    // Two rows that normalise to the same restaurant are near-certainly a
    // duplicate in the source data ("SARTH MILK & MILK PRODUCTS" and "SARTH
    // MILK AND MILK PRODUCTS"). Both are reported so the office can clean the
    // master list, and the one carrying an actual address is the one kept —
    // taking whichever happened to come first can leave the useful row on the
    // floor and the empty one on the map.
    const prev = seen.get(id);
    if (prev) {
      const better = (base.address || '').length > (prev.address || '').length;
      problems.push({
        row: r + 1,
        name,
        error: `Same restaurant as row ${prev.row} ("${prev.name}"). Kept the one with the fuller address.`,
      });
      if (!better) continue;
    }
    seen.set(id, { row: r + 1, name, address: base.address });

    if (hasCoords) {
      const { place, error } = validatePlace({ ...base, lat: Number(at('lat')), lng: Number(at('lng')) }, { isFacility: false });
      if (error) { problems.push({ row: r + 1, error, name }); continue; }
      // The sheet's own coordinates are always kept, as evidence, apart from
      // the pin in use.
      const { lat: sheetLatV, lng: sheetLngV, ...details } = place;
      const sheet = { sheetLat: sheetLatV, sheetLng: sheetLngV, importedAt: Date.now(), importedBy: req.adminId };
      if (existingPin.has(id)) {
        writer.set(repo.C.restaurants().doc(id), { ...details, ...sheet }, { merge: true });
      } else {
        const { fields, entry } = pinChange(null, { lat: sheetLatV, lng: sheetLngV, source: 'spreadsheet', by: `admin:${req.adminId}`, reason: 'Coordinates from the imported spreadsheet.' });
        writer.set(repo.C.restaurants().doc(id), { ...details, ...sheet, ...fields, locationHistory: [entry] }, { merge: true });
      }
    } else if (existing.has(id)) {
      // Known row: refresh the details from the file, leave the location alone.
      writer.set(repo.C.restaurants().doc(id),
        { ...base, importedAt: Date.now(), importedBy: req.adminId },
        { merge: true });
    } else {
      // A food truck is a customer that is not at an address. Sending it to
      // the lookup would pay Google to find a building that does not exist and
      // then geofence wherever the guess landed — so passing drivers register
      // visits that never happened and real deliveries register nothing. It
      // goes in with its own status instead, which the lookup does not read.
      const mobile = mobileVendor.looksMobile({ name, address: base.address, area });
      if (mobile) mobileCount += 1;
      writer.set(repo.C.restaurants().doc(id), {
        ...base,
        mobile,
        locationStatus: mobile ? mobileVendor.MOBILE_STATUS : 'pending',
        importedAt: Date.now(),
        importedBy: req.adminId,
        createdAt: Date.now(),
      });
    }
    (existing.has(id) ? updated : added).push(id);
  }
  await writer.close();
  repo.invalidatePlaceCache();

  const pending = (await repo.C.restaurants().where('locationStatus', 'in', ['pending', 'unconfirmed']).select().get()).size;
  await repo.writeAudit({
    adminId: req.adminId,
    action: 'restaurants.import',
    after: { added: added.length, updated: updated.length, problems: problems.length, awaitingLocation: pending },
  });
  res.json({
    success: true,
    data: {
      added: added.length, updated: updated.length, problems,
      awaitingLocation: pending, mobile: mobileCount,
    },
  });
});

// GET /admin/restaurants/awaiting-location
// Everything the engine is currently ignoring, and why.
//
// The list of rows is capped — nobody reads three thousand of them — but the
// counts are not: they are the whole list, counted. Reporting "500" when 3,152
// were waiting told the office the job was done when it had barely started.
router.get('/restaurants/awaiting-location', requireRole('viewer'), async (req, res) => {
  const snap = await repo.C.restaurants().where('locationStatus', 'in', ['pending', 'unconfirmed']).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const counts = {
    total: rows.length,
    pending: 0,
    unconfirmed: 0,
    business: 0,   // a real business was found, but under a different name
    street: 0,     // the right road, from an address in the spreadsheet
    areaOnly: 0,   // the middle of a suburb — never acceptable in bulk
    notFound: 0,
  };
  for (const p of rows) {
    if (p.locationStatus === 'pending') { counts.pending += 1; continue; }
    counts.unconfirmed += 1;
    const c = p.candidate && p.candidate.confidence;
    if (c === BULK.business) counts.business += 1;
    else if (c === BULK.street) counts.street += 1;
    else if (c === geocode.CONFIDENCE.AREA_ONLY) counts.areaOnly += 1;
    else counts.notFound += 1;
  }

  // The rows a person can decide in a second come first — a named business
  // they will recognise, then a street. Burying those under the hopeless ones
  // is what made this screen feel like three thousand forms to fill in.
  const order = { BUSINESS_UNSURE: 0, APPROXIMATE: 1, AREA_ONLY: 2 };
  rows.sort((a, b) => {
    const ra = a.locationStatus === 'pending' ? 4 : (order[a.candidate?.confidence] ?? 3);
    const rb = b.locationStatus === 'pending' ? 4 : (order[b.candidate?.confidence] ?? 3);
    return ra - rb;
  });

  res.json({ success: true, data: { counts, rows: rows.slice(0, 200) } });
});

// POST /admin/restaurants/retry-unconfirmed
//
// Puts the held rows back in the queue so the next run looks at them again.
//
// This exists because the lookup got better after the first run. Rows held as
// "the right road" or "a whole suburb" were answered by the address lookup
// alone; asking Places for the business by name may well find the building.
// Without this the only way to benefit would be to delete and re-import,
// which would throw away every pin the office had already placed.
//
// A row somebody has confirmed is never touched: this moves 'unconfirmed' back
// to 'pending' and nothing else.
router.post('/restaurants/retry-unconfirmed', requireRole('admin'), writeLimiter, async (req, res) => {
  if (await refuseIfLocked(req, res)) return;
  const snap = await repo.C.restaurants().where('locationStatus', '==', 'unconfirmed').get();
  let queued = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of snap.docs.slice(i, i + 400)) {
      batch.set(doc.ref, { locationStatus: 'pending' }, { merge: true });
      queued += 1;
    }
    /* eslint-disable-next-line no-await-in-loop */
    await batch.commit();
  }
  await repo.writeAudit({ adminId: req.adminId, action: 'restaurants.retry_unconfirmed', after: { queued } });
  res.json({ success: true, data: { queued } });
});

// POST /admin/restaurants/accept-candidates { kind, limit }
//
// Nobody is going to type three thousand pairs of coordinates, and asking them
// to is how a list like this quietly stops being kept up to date — which costs
// more accuracy in the end than the caution was protecting.
//
// So candidates can be accepted together. But "accept the uncertain ones" is
// not one decision, it is two, with different things going wrong in each, so
// the caller has to say which:
//
//   kind=business  A real business at its own building, but Google names it
//                  something else — "Sai Restaurant" where the file says "Sai
//                  Palace". Precise if it is the same shop, several hundred
//                  metres out if it is the one next door.
//
//   kind=street    The right road, from an address the office typed. Tens of
//                  metres out at worst, and a driver standing on that road is
//                  genuinely there on Modern Dairy business.
//
//   kind=area      The office's explicit override, and the one to understand
//                  before using. The geocoder found only a suburb, so the pin
//                  sits at the middle of Kothrud rather than at the shop.
//
//                  What that costs is not a wide geofence — the geofence is
//                  the usual 80 m. It is that the pin is in the WRONG PLACE,
//                  which cuts both ways: a driver standing at the real
//                  restaurant triggers nothing, and a driver merely passing
//                  the middle of the suburb on a private errand triggers a
//                  visit that never happened.
//
//                  It is offered because a restaurant with no pin at all is
//                  invisible to everything — no geofence, no visit, no
//                  kilometres — and the office judged a rough pin better than
//                  none. That is their call to make. These rows are written
//                  with locationSource 'accepted_in_bulk_AREA_ONLY' so they
//                  can be listed and corrected properly later, and the screen
//                  makes the choice explicit rather than hiding it in a count.
//
// Rows with no candidate at all have nothing to accept.
// 'area' is the office's own override. It is not offered alongside the other
// two and it is not reachable by accident: the screen makes you tick a box
// that says what you are accepting before the button exists. See the comment
// on the route below for why it is kept at arm's length.
const BULK = {
  business: 'BUSINESS_UNSURE',
  street: geocode.CONFIDENCE.APPROXIMATE,
  area: geocode.CONFIDENCE.AREA_ONLY,
};

router.post('/restaurants/accept-candidates', requireRole('admin'), writeLimiter, async (req, res) => {
  if (await refuseIfLocked(req, res)) return;
  const limit = Math.min(Math.max(Number(req.body?.limit) || 500, 1), 1000);
  const wanted = BULK[String(req.body?.kind || 'street')];
  if (!wanted) return bad(res, 'Unknown kind of candidate');

  const snap = await repo.C.restaurants().where('locationStatus', '==', 'unconfirmed').get();

  const eligible = snap.docs.filter((d) => {
    const c = d.data().candidate;
    return !!c
      && c.confidence === wanted
      && Number.isFinite(c.lat) && Number.isFinite(c.lng);
  });

  const take = eligible.slice(0, limit);
  let accepted = 0;
  for (let i = 0; i < take.length; i += 400) {
    const batch = db.batch();
    for (const doc of take.slice(i, i + 400)) {
      const c = doc.data().candidate;
      const { fields, entry } = pinChange(doc.data(), {
        lat: c.lat, lng: c.lng, source: `accepted_in_bulk_${wanted}`, by: `admin:${req.adminId}`,
        reason: `Lookup candidate (${wanted}) accepted in bulk.`,
      });
      batch.set(doc.ref, { ...fields, confirmedBy: req.adminId, confirmedAt: Date.now(), locationHistory: FieldValue.arrayUnion(entry) }, { merge: true });
      accepted += 1;
    }
    /* eslint-disable-next-line no-await-in-loop */
    await batch.commit();
  }

  repo.invalidatePlaceCache();
  await repo.writeAudit({
    adminId: req.adminId,
    action: 'restaurants.accept_candidates',
    after: { kind: wanted, accepted, remaining: eligible.length - accepted },
  });
  res.json({ success: true, data: { accepted, remaining: eligible.length - accepted } });
});

// POST /admin/restaurants/locate { limit }
//
// Finds a batch of the pending rows. A batch rather than all of them: three
// thousand lookups do not fit in one HTTP request, and a run that times out
// half way through is worse than one that says how far it got. Call it again
// until nothing is pending.
//
// Two different questions get asked, cheapest first, because they cost very
// different amounts and often give the same answer:
//
//   1. Geocoding — "where is this address?" Most rows in the office's export
//      carry a real street address, and for those the geocoder returns the
//      building itself (ROOFTOP). That is already precise, and it is the cheap
//      lookup, so there is nothing to gain by paying for more.
//
//   2. Places — "where is this business?" Asked only when the geocoder could
//      not find a building: no address in the row, or an address that only
//      resolved to a road or a suburb. Places knows the restaurant by name and
//      returns the building it occupies, plus the name Google holds for it —
//      which is what makes it safe to place automatically.
//
// Asking Places for every row would cost several times as much and would not
// improve a single row the geocoder had already pinned to a building.
//
// Anything neither could settle is held with whatever was found, so the person
// looking at it sees a business name rather than a pair of numbers.
router.post('/restaurants/locate', requireRole('admin'), batchLimiter, async (req, res) => {
  if (await refuseIfLocked(req, res)) return;
  const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 200);
  const apiKey = await getSecret('geocoding');
  if (!apiKey) {
    return res.status(400).json({
      success: false,
      code: 'NO_GEOCODING_KEY',
      message: 'No lookup key is configured, so locations cannot be looked up yet.',
    });
  }

  const snap = await repo.C.restaurants().where('locationStatus', '==', 'pending').limit(limit).get();
  let placed = 0; let heldForReview = 0; let notFound = 0;
  let precise = 0;
  const failures = [];
  // If the key has no access to Places, every row would raise the same error.
  // Report it once, then carry on with geocoding alone for the rest.
  let placesOff = false;

  for (const doc of snap.docs) {
    const p = doc.data();
    const row = { name: p.name, area: p.area, address: p.address };

    // ── 1. the address (cheap) ────────────────────────────────────────────
    let geo = null;
    const query = geocode.buildQuery(row);
    try {
      /* eslint-disable-next-line no-await-in-loop */
      geo = await geocode.geocodeOne(query, apiKey, {
        hasStreetAddress: geocode.looksLikeStreetAddress(p.address),
      });
    } catch (e) {
      failures.push({ name: p.name, error: e.message });
      if (e.message === 'OVER_QUERY_LIMIT') break;   // stop rather than burn the quota
      /* eslint-disable-next-line no-await-in-loop */
      continue;
    }

    // ── 2. the business itself, only when that did not find a building ────
    //
    // A ROOFTOP geocode already IS the building. Paying Places to confirm it
    // would buy nothing. Everything else — a road, a suburb, nothing at all —
    // is worth asking about by name.
    let hit = null;
    const geocoderFoundTheBuilding = geo && geo.confidence === geocode.CONFIDENCE.EXACT;
    if (!geocoderFoundTheBuilding && !placesOff) {
      try {
        /* eslint-disable-next-line no-await-in-loop */
        hit = await placesApi.searchOne(row, apiKey);
      } catch (e) {
        if (e.notEnabled) {
          placesOff = true;
          failures.push({
            name: p.name,
            error: 'The key cannot use the Places API yet, so restaurants without a usable '
              + 'street address cannot be found by name. '
              + 'Enable "Places API (New)" on this key in the Google Cloud console.',
            advisory: true,
          });
        } else if (e.overQuota) {
          failures.push({ name: p.name, error: e.message });
          break;
        } else {
          failures.push({ name: p.name, error: e.message });
        }
        hit = null;
      }
    }

    // Prefer whichever actually identified a building. A named business beats a
    // road; a rooftop geocode beats a business whose name does not match.
    const placesIsBetter = hit && hit.point && !geocoderFoundTheBuilding;
    const found = placesIsBetter ? hit : (geo && geo.point ? geo : (hit || geo));
    const patch = {
      geocode: {
        source: found === hit ? 'places' : 'geocoding',
        query: found ? found.query : null,
        // One vocabulary for the screen: PRECISE beats a street, a street beats
        // a suburb, and "found something, unsure which" is its own case.
        confidence: found === hit
          ? (hit.match === placesApi.MATCH.STRONG ? 'PRECISE' : 'BUSINESS_UNSURE')
          : (geo ? geo.confidence : geocode.CONFIDENCE.NONE),
        match: hit ? hit.match : null,
        displayName: (found && found.point && found.point.displayName) || null,
        alternatives: found ? found.alternatives : 0,
        formattedAddress: (found && found.point) ? found.point.formattedAddress : null,
        at: Date.now(),
      },
    };

    if (found && found.autoPlace && found.point) {
      // A business placed under a name that is not the office's own is marked
      // apart from the rest, so these can be listed and re-checked later
      // rather than disappearing into the pile.
      const source = found === hit
        ? (hit.match === placesApi.MATCH.STRONG ? 'places' : 'places_name_differs')
        : 'geocoded';
      const { fields, entry } = pinChange(p, {
        lat: found.point.lat, lng: found.point.lng, source, by: `system:locate(admin:${req.adminId})`,
        reason: `Placed by the lookup: ${found.point.displayName || found.point.formattedAddress || 'address'}.`,
      });
      Object.assign(patch, fields, { locationHistory: FieldValue.arrayUnion(entry) });
      placed += 1;
      // "Precise" means the building itself, however it was found: a named
      // business, or an address the geocoder resolved to a rooftop.
      if (found === hit || geocoderFoundTheBuilding) precise += 1;
    } else if (found && found.point) {
      // A candidate, not a location. Kept off lat/lng on purpose: the engine
      // reads lat/lng, and a guess must not reach it.
      patch.candidate = {
        lat: found.point.lat,
        lng: found.point.lng,
        confidence: patch.geocode.confidence,
        displayName: found.point.displayName || null,
      };
      patch.locationStatus = 'unconfirmed';
      heldForReview += 1;
    } else {
      patch.locationStatus = 'unconfirmed';
      notFound += 1;
    }
    /* eslint-disable-next-line no-await-in-loop */
    await doc.ref.set(patch, { merge: true });
  }

  repo.invalidatePlaceCache();
  const stillPending = (await repo.C.restaurants().where('locationStatus', '==', 'pending').select().get()).size;
  await repo.writeAudit({
    adminId: req.adminId,
    action: 'restaurants.locate',
    after: { placed, precise, heldForReview, notFound, stillPending },
  });
  res.json({
    success: true,
    data: { looked: snap.size, placed, precise, heldForReview, notFound, stillPending, failures },
  });
});

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

// GET /admin/maintenance — past audits, newest first.
router.get('/maintenance', requireRole('manager'), async (req, res) => {
  const [audits, secrets] = await Promise.all([
    maintenance.listAudits({ limit: 12 }),
    secretStatus(),
  ]);
  res.json({
    success: true,
    data: { audits, hasKey: secrets.anthropic === 'configured', model: maintenance.MODEL },
  });
});

// POST /admin/maintenance/run — audit the running system.
//
// admin-only and rate-limited: each run costs real money on the office's own
// Anthropic account, and the answer does not change minute to minute.
router.post('/maintenance/audit', requireRole('admin'), writeLimiter, async (req, res) => {
  try {
    const out = await maintenance.runAudit({ adminId: req.adminId });
    res.json({ success: true, data: out });
  } catch (e) {
    if (e.code === 'NO_ANTHROPIC_KEY') {
      return res.status(400).json({ success: false, code: e.code, message: e.message });
    }
    // An API key that is wrong, out of credit or rate-limited is the common
    // case, and the office can act on each of those — so say which.
    const status = e.status || 500;
    const message = status === 401 ? 'That Anthropic API key was rejected. Check it and save it again.'
      : status === 429 ? 'Anthropic is rate-limiting this key. Try again in a few minutes.'
        : status === 400 && /credit|balance/i.test(e.message || '') ? 'The Anthropic account is out of credit.'
          : (e.message || 'The audit could not be completed.');
    return res.status(status === 401 || status === 429 ? status : 500)
      .json({ success: false, message });
  }
});

// GET / PUT /admin/locations-lock
//
// The latch on the restaurant list. See repo.getLocationsLock for why.
//
// Note what it does NOT cover: putting supply on hold, and moving a single
// pin. Those are the daily work, and locking them would mean unlocking the
// screen every time an invoice runs late — which is how a lock ends up
// permanently off.
router.get('/locations-lock', requireRole('viewer'), async (req, res) => {
  res.json({ success: true, data: await repo.getLocationsLock() });
});

router.put('/locations-lock', requireRole('admin'), writeLimiter, async (req, res) => {
  const locked = req.body?.locked === true;
  res.json({ success: true, data: await repo.setLocationsLock(locked, req.adminId) });
});

// Guard for the bulk operations. A greyed-out button is a suggestion; this is
// the rule, and it sits in front of every route that can rewrite the list.
async function refuseIfLocked(req, res) {
  const { locked, lockedBy, lockedAt } = await repo.getLocationsLock();
  if (!locked) return false;
  res.status(409).json({
    success: false,
    code: 'LOCATIONS_LOCKED',
    message: 'The restaurant list is locked'
      + (lockedBy ? ` (by ${lockedBy}` + (lockedAt ? ` on ${new Date(lockedAt).toDateString()})` : ')') : '')
      + '. Unlock it on the Locations screen before importing or re-running the lookup.',
  });
  return true;
}

// POST /admin/restaurants/:id/mobile { on }
//
// Move a row between "food truck" and "restaurant".
//
// The import guesses from the word "truck", and a word match is wrong
// sometimes — an address on Truck Terminal Road is a building. Both mistakes
// cost something: a restaurant wrongly marked mobile silently stops being
// located and stops being tracked, and a truck wrongly left as a restaurant
// gets a geofence in a place it may never park. So the guess is always
// correctable from the screen.
router.post('/restaurants/:id/mobile', requireRole('manager'), writeLimiter, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return bad(res, 'Invalid id');
  const on = req.body?.on !== false;

  const ref = repo.C.restaurants().doc(id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Not found' });
  const before = doc.data();

  const patch = { mobile: on };
  if (on) {
    // Off to the mobile list, and any pin it picked up is dropped. A pin on a
    // truck is worse than no pin: it geofences somewhere the truck may never
    // park, so passers-by register visits and real deliveries register none.
    // The position itself is kept in the history and in removedPin.
    patch.locationStatus = mobileVendor.MOBILE_STATUS;
    const { fields, entry } = pinRemoval(before, { by: `admin:${req.adminId}`, reason: 'Marked as a food truck: no fixed place.' });
    Object.assign(patch, fields);
    if (entry) patch.locationHistory = FieldValue.arrayUnion(entry);
  } else if (!(Number.isFinite(before.lat) && Number.isFinite(before.lng)) && before.removedPin && Number.isFinite(before.removedPin.lat)) {
    // Back to being a place: the pin it had before the flag comes back.
    const { fields, entry } = pinChange(before, { lat: before.removedPin.lat, lng: before.removedPin.lng, source: before.removedPin.source || 'restored',
      by: `admin:${req.adminId}`, reason: 'Food-truck flag removed; the earlier pin is put back.' });
    Object.assign(patch, fields, { removedPin: null, locationHistory: FieldValue.arrayUnion(entry) });
  } else {
    // Back to being a place, and back into the queue the lookup reads.
    patch.locationStatus = Number.isFinite(before.lat) && Number.isFinite(before.lng)
      ? 'confirmed' : 'pending';
  }

  await ref.set(patch, { merge: true });
  repo.invalidatePlaceCache();
  await repo.writeAudit({
    adminId: req.adminId,
    action: on ? 'restaurants.mark_mobile' : 'restaurants.unmark_mobile',
    target: id,
    before: { mobile: before.mobile === true, locationStatus: before.locationStatus },
    after: { mobile: on, locationStatus: patch.locationStatus },
  });
  res.json({ success: true, data: { id, mobile: on } });
});

// POST /admin/restaurants/:id/hold { on, reason }
//
// Supply on hold. A restaurant on hold is not offered to any driver and cannot
// be put into a round — unpaid account, a dispute, a shop shut for a month.
//
// Deliberately NOT the same thing as 'active'. Inactive means the customer is
// gone and the row is history; on hold means stop supplying today and expect
// to resume, which is a decision somebody makes and unmakes weekly. Rolling
// them together would mean deleting and re-adding a customer every time an
// invoice is late, and losing every pin and learned road with it.
//
// The geofence stays. If a driver goes anyway the visit is still recorded —
// the office needs to see that far more than it needs a clean map, and a
// silently missing geofence would just look like the driver went nowhere.
router.post('/restaurants/:id/hold', requireRole('manager'), writeLimiter, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return bad(res, 'Invalid id');
  const on = req.body?.on !== false;
  const reason = req.body?.reason == null ? null : String(req.body.reason).slice(0, 300);
  if (on && !isBoundedString(reason || '', { min: 1, max: 300 })) {
    // A hold with no reason is one nobody can lift with any confidence a week
    // later, and the driver's screen has nothing to show them.
    return bad(res, 'Say why supply is on hold — the drivers and the next person to look will need it.');
  }

  const ref = repo.C.restaurants().doc(id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Not found' });

  await ref.set({
    supplyHold: on,
    holdReason: on ? reason : null,
    holdSetBy: on ? req.adminId : null,
    holdSetAt: on ? Date.now() : null,
    holdLiftedAt: on ? null : Date.now(),
  }, { merge: true });
  repo.invalidatePlaceCache();
  await repo.writeAudit({
    adminId: req.adminId,
    action: on ? 'restaurants.hold' : 'restaurants.unhold',
    target: id,
    before: { supplyHold: doc.data().supplyHold === true },
    after: { supplyHold: on, reason: on ? reason : null },
  });
  res.json({ success: true, data: { id, supplyHold: on, holdReason: on ? reason : null } });
});

// POST /admin/restaurants/:id/confirm-location { lat, lng }
// A person accepting or correcting a pin. This is the only way a guess becomes
// a location the kilometre figures rely on.
router.post('/restaurants/:id/confirm-location', requireRole('admin'), writeLimiter, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return bad(res, 'Invalid id');
  const doc = await repo.C.restaurants().doc(id).get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Not found' });

  const body = req.body || {};
  const cand = doc.data().candidate || {};
  const lat = Number.isFinite(Number(body.lat)) ? Number(body.lat) : cand.lat;
  const lng = Number.isFinite(Number(body.lng)) ? Number(body.lng) : cand.lng;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return bad(res, 'A valid latitude is required');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return bad(res, 'A valid longitude is required');

  const { fields, entry } = pinChange(doc.data(), {
    lat, lng,
    source: body.lat != null ? 'office' : 'geocoded_confirmed',
    by: `admin:${req.adminId}`,
    reason: isBoundedString(body.reason, { min: 3, max: 300 }) ? body.reason.trim()
      : body.lat != null ? 'Placed on the map by the office.' : 'Lookup candidate confirmed by the office.',
  });
  await doc.ref.set({ ...fields, confirmedBy: req.adminId, confirmedAt: Date.now(), locationHistory: FieldValue.arrayUnion(entry) }, { merge: true });
  repo.invalidatePlaceCache();
  await repo.writeAudit({ adminId: req.adminId, action: 'restaurants.confirm_location', target: id, after: { lat, lng } });
  res.json({ success: true, data: { id, lat, lng } });
});

// ---------------------------------------------------------------------------
// Location audit: every restaurant's stored location against Google Maps.
// See services/locationAudit.js for the searches, the evidence and the five
// verdicts. The audit never moves a pin; applying a result is a separate,
// deliberate, audited step, and every move keeps the old position.
// ---------------------------------------------------------------------------

// POST /admin/restaurants/location-audit { recheck | recheckBefore, limit }
// A batch at a time; the dashboard calls it until nothing is left.
router.post('/restaurants/location-audit', requireRole('admin'), batchLimiter, async (req, res) => {
  const apiKey = await getSecret('geocoding');
  if (!apiKey) {
    return res.status(400).json({ success: false, code: 'NO_GEOCODING_KEY', message: 'No Google key is configured, so restaurants cannot be checked yet.' });
  }
  // Up to four Google requests per restaurant, so modest batches.
  const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 60);
  // A "check all again" run is timed by the server's clock, never the office
  // PC's: a PC clock running ahead would make the run never finish.
  const before = req.body?.recheck === true ? Date.now()
    : Number.isFinite(Number(req.body?.recheckBefore)) ? Number(req.body.recheckBefore) : null;

  const snap = await repo.C.restaurants().get();
  const due = snap.docs.filter((d) => locationAudit.needsAudit(d.data(), { before }));
  // The suburb-only pins first: they are the ones most likely to be wrong.
  due.sort((a, b) => (b.get('locationSource') === 'accepted_in_bulk_AREA_ONLY') - (a.get('locationSource') === 'accepted_in_bulk_AREA_ONLY'));
  const batch = due.slice(0, limit);
  const counts = {};
  let failed = 0;
  let stoppedFor = null;
  const CONCURRENCY = 3;
  for (let i = 0; i < batch.length && !stoppedFor; i += CONCURRENCY) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.slice(i, i + CONCURRENCY).map(async (doc) => {
      try {
        const v = await locationAudit.auditOne(doc.data(), apiKey);
        await doc.ref.set({ locationAudit: v }, { merge: true });
        counts[v.status] = (counts[v.status] || 0) + 1;
      } catch (e) {
        failed += 1;
        if (e.notEnabled) stoppedFor = 'The Google key cannot use the Places API. Enable "Places API (New)" on it in the Google Cloud console.';
        else if (e.overQuota || /OVER_QUERY_LIMIT/.test(e.message)) stoppedFor = 'Google\'s rate limit was reached. Wait a minute and carry on — nothing is lost.';
        else if (/refused the request/.test(e.message)) stoppedFor = 'The Google key cannot use the Geocoding API. Enable it in the Google Cloud console. (' + e.message + ')';
      }
    }));
  }
  const checked = Object.values(counts).reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, due.length - checked);
  await repo.writeAudit({ adminId: req.adminId, action: 'restaurants.location_audit', after: { checked, counts, failed, remaining } });
  res.json({ success: true, data: { checked, counts, failed, remaining, stoppedFor, recheckBefore: before } });
});

// Moving a pin to the business the audit found. The verdict is kept on the
// history entry, so the move can always be explained.
function auditMove(before, adminId, note) {
  const a = before.locationAudit || {};
  const { fields, entry } = pinChange(before, {
    lat: a.found.lat, lng: a.found.lng, source: 'google_places', by: `admin:${adminId}`,
    reason: note || `Location audit: ${a.reason}`,
    verification: { status: a.status, confidence: a.confidence, distanceM: a.distanceM ?? null, foundName: a.found.name || null, placeId: a.found.placeId || null, auditedAt: a.at },
  });
  // The audit now describes the new pin: the business is where the pin is.
  const verified = { ...a, status: locationAudit.STATUS.VERIFIED, distanceM: 0, pinLat: a.found.lat, pinLng: a.found.lng,
    pinSource: 'google_places', placedByHand: false, storedIsSuburb: false, action: 'Keep the existing location.',
    reason: `Moved to "${a.found.name}" on Google Maps by the office (was: ${a.status}).` };
  return { ...fields, confirmedBy: adminId, confirmedAt: Date.now(), locationAudit: verified, locationHistory: FieldValue.arrayUnion(entry) };
}

// POST /admin/restaurants/:id/apply-audit-location { reason? }
// One restaurant, after a person has looked: its pin goes to the business the
// audit found. Refused if the audit is stale (the pin or the row changed).
router.post('/restaurants/:id/apply-audit-location', requireRole('admin'), writeLimiter, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return bad(res, 'Invalid id');
  const doc = await repo.C.restaurants().doc(id).get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Not found' });
  const before = doc.data();
  const a = before.locationAudit;
  if (!a || !a.found || !Number.isFinite(a.found.lat)) return bad(res, 'The location audit found no business to move to.');
  if (locationAudit.isStale(before)) return bad(res, 'This restaurant changed since it was checked. Check it again first.');
  const note = isBoundedString(req.body?.reason, { min: 3, max: 300 }) ? `${req.body.reason.trim()} (audit: ${a.status})` : null;
  const update = auditMove(before, req.adminId, note);
  await doc.ref.set(update, { merge: true });
  repo.invalidatePlaceCache();
  await repo.writeAudit({ adminId: req.adminId, action: 'restaurants.apply_audit_location', target: id,
    before: { lat: before.lat ?? null, lng: before.lng ?? null, source: before.locationSource || null },
    after: { lat: update.lat, lng: update.lng, status: a.status, confidence: a.confidence } });
  res.json({ success: true, data: { id, lat: update.lat, lng: update.lng } });
});

// POST /admin/restaurants/apply-audit-locations { ids }
// The bulk button: only HIGH-confidence significant differences, never a pin
// the office placed by hand, never a stale verdict (locationAudit.bulkApplicable).
router.post('/restaurants/apply-audit-locations', requireRole('admin'), writeLimiter, async (req, res) => {
  if (await refuseIfLocked(req, res)) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isValidId).slice(0, 500) : [];
  if (!ids.length) return bad(res, 'No restaurants given.');
  let moved = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += 100) {
    /* eslint-disable no-await-in-loop */
    const docs = await Promise.all(ids.slice(i, i + 100).map((id) => repo.C.restaurants().doc(id).get()));
    const batch = db.batch();
    const audits = [];
    for (const doc of docs) {
      const before = doc.exists ? doc.data() : null;
      if (!before || !locationAudit.bulkApplicable(before)) { skipped += 1; continue; }
      const update = auditMove(before, req.adminId, null);
      batch.set(doc.ref, update, { merge: true });
      moved += 1;
      audits.push({ adminId: req.adminId, action: 'restaurants.apply_audit_location', target: doc.id,
        before: { lat: before.lat ?? null, lng: before.lng ?? null, source: before.locationSource || null },
        after: { lat: update.lat, lng: update.lng, bulk: true, status: before.locationAudit.status, confidence: before.locationAudit.confidence } });
    }
    if (audits.length) {
      await batch.commit();
      for (const a of audits) await repo.writeAudit(a);
    }
    /* eslint-enable no-await-in-loop */
  }
  if (moved) repo.invalidatePlaceCache();
  res.json({ success: true, data: { moved, skipped } });
});

// GET /admin/restaurants/location-audit.csv — the location audit report: one
// row per restaurant, checked or not, with the columns the office asked for.
router.get('/restaurants/location-audit.csv', requireRole('viewer'), async (req, res) => {
  const snap = await repo.C.restaurants().get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => p.active !== false && p.mobile !== true && p.locationStatus !== 'mobile')
    .map((p) => {
      const a = p.locationAudit || {};
      const stale = locationAudit.isStale(p);
      const f = a.found || {};
      return {
        customerId: p.customerId || '', id: p.id, name: p.name, address: p.address || '', area: p.area || '',
        ourLat: Number.isFinite(p.lat) ? p.lat : '', ourLng: Number.isFinite(p.lng) ? p.lng : '', ourSource: p.locationSource || (Number.isFinite(p.lat) ? 'spreadsheet' : ''),
        googleName: stale ? '' : (f.name || ''), googleAddress: stale ? '' : (f.address || ''),
        googleLat: stale || !Number.isFinite(f.lat) ? '' : f.lat, googleLng: stale || !Number.isFinite(f.lng) ? '' : f.lng,
        googleLink: stale || !f.placeId ? '' : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(f.name || p.name)}&query_place_id=${encodeURIComponent(f.placeId)}`,
        distanceM: stale || a.distanceM == null ? '' : a.distanceM,
        status: stale ? 'NOT_CHECKED' : a.status, confidence: stale ? '' : (a.confidence || ''),
        reason: stale ? (a.at ? 'Changed since the last check.' : 'Not checked yet.') : a.reason, action: stale ? 'Run the location audit.' : a.action,
        foundVia: stale ? '' : (f.via || ''), suburbOnly: a.storedIsSuburb ? 'yes' : '', placedByHand: a.placedByHand ? 'yes' : '',
        checkedAt: a.at ? new Date(a.at).toISOString() : '',
        original: p.originalLocation ? `${p.originalLocation.lat},${p.originalLocation.lng} (${p.originalLocation.source})` : '',
        moves: Array.isArray(p.locationHistory) ? p.locationHistory.length : 0,
      };
    });
  const columns = [
    { key: 'customerId', label: 'Customer ID' }, { key: 'name', label: 'Our name' },
    { key: 'ourLat', label: 'Our latitude' }, { key: 'ourLng', label: 'Our longitude' }, { key: 'ourSource', label: 'Our source' },
    { key: 'googleName', label: 'Google name' }, { key: 'googleLat', label: 'Google latitude' }, { key: 'googleLng', label: 'Google longitude' },
    { key: 'distanceM', label: 'Distance (m)' }, { key: 'status', label: 'Status' }, { key: 'confidence', label: 'Confidence' },
    { key: 'reason', label: 'Reason' }, { key: 'action', label: 'Recommended action' },
    { key: 'googleAddress', label: 'Google address' }, { key: 'googleLink', label: 'Google Maps link' }, { key: 'foundVia', label: 'Found by' },
    { key: 'address', label: 'Sheet address' }, { key: 'area', label: 'Sheet area' }, { key: 'suburbOnly', label: 'Our pin is a suburb centre' },
    { key: 'placedByHand', label: 'Placed by hand' }, { key: 'original', label: 'Original location' }, { key: 'moves', label: 'Pin moves' },
    { key: 'checkedAt', label: 'Checked at' }, { key: 'id', label: 'Record ID' },
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="location-audit.csv"');
  res.send('﻿' + reports.toCsv(columns, rows));
});

router.get('/restaurants/export.csv', requireRole('viewer'), async (req, res) => {
  const snap = await repo.C.restaurants().get();
  const columns = [
    { key: 'name', label: 'name' }, { key: 'customerId', label: 'customer_id' },
    { key: 'address', label: 'address' }, { key: 'lat', label: 'lat' }, { key: 'lng', label: 'lng' },
    { key: 'radiusM', label: 'radius_m' }, { key: 'area', label: 'area' },
    { key: 'externalId', label: 'external_id' }, { key: 'schedule', label: 'schedule' },
    { key: 'active', label: 'active' },
  ];
  const csv = reports.toCsv(columns, snap.docs.map((d) => d.data()));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="restaurants.csv"');
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Orders / integration
// ---------------------------------------------------------------------------

// GET /admin/maps-config — which maps to draw, and the browser key for them.
//
// The browser key is not a secret in the way the others are: a page that
// draws a Google map has to hand its key to the browser. It is protected by
// the website restrictions on it in the Google Cloud console. It is served
// here, after sign-in, rather than written into the public repository, so it
// can be changed without a rebuild and is not indexed by every code search.
router.get('/maps-config', requireRole('viewer'), async (req, res) => {
  const key = await getSecret('maps_browser');
  res.json({ success: true, data: key ? { provider: 'google', key } : { provider: 'free' } });
});

// GET /admin/integration/secrets
//
// Whether each key is set — never what it is. Saving a key into a box that
// then looks exactly as empty as before gives no reason to believe it worked,
// and "trust me" is not an answer when the next question is why the lookup is
// failing. This is the smallest honest thing the screen can show: it asks the
// place the key actually lives.
router.get('/integration/secrets', requireRole('admin'), async (req, res) => {
  try {
    res.json({ success: true, data: await secretStatus() });
  } catch (e) {
    console.error('could not read secret status', e);
    res.status(500).json({ success: false, message: 'Could not check which keys are saved: ' + e.message });
  }
});

// PUT /admin/integration/secret { alias, value }
//
// Lets the office configure an integration key from the dashboard instead of a
// terminal. The value goes straight into Secret Manager and is never stored in
// Firestore, never logged, and never read back out to the browser — the UI can
// only ever learn whether a key is set, not what it is.
//
// jwt-signing-key is deliberately not settable here. Replacing it invalidates
// every driver's token and signs forty phones out mid-shift; that is a
// deliberate operation, not a form field.
router.put('/integration/secret', requireRole('admin'), writeLimiter, async (req, res) => {
  const { alias, value } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(KNOWN_SECRETS, alias)) return bad(res, 'Unknown setting');
  if (alias === 'jwt-signing-key') return bad(res, 'The signing key cannot be changed from here.');
  if (!isBoundedString(value, { min: 8, max: 4000 })) return bad(res, 'That value looks wrong.');
  try {
    await setSecret(alias, value.trim());
  } catch (e) {
    console.error('could not store secret', alias, e);
    return res.status(500).json({ success: false, message: 'Could not store that key: ' + e.message });
  }
  // The value itself never goes near the audit trail.
  await repo.writeAudit({ adminId: req.adminId, action: 'integration.secret_set', after: { alias } });
  res.json({ success: true, data: { alias, set: true } });
});

router.get('/integration/sources', requireRole('viewer'), async (req, res) => {
  const out = [];
  for (const name of orderSource.list()) {
    const a = orderSource.get(name);
    /* eslint-disable-next-line no-await-in-loop */
    out.push({ name, description: a.description, configured: await a.isConfigured() });
  }
  const logs = await repo.C.integrationLogs().orderBy('at', 'desc').limit(20).get();
  res.json({ success: true, data: { sources: out, recentLogs: logs.docs.map((d) => d.data()) } });
});

router.post('/orders/import', requireRole('admin'), writeLimiter, async (req, res) => {
  const { csv } = req.body || {};
  if (!isBoundedString(csv, { min: 1, max: 5_000_000 })) return bad(res, 'csv is required');
  const drivers = await repo.listDrivers({ includeInactive: true });
  const codeToId = new Map(drivers.map((d) => [d.driverCode, d.id]));
  const { orders, problems } = manual.parseOrdersCsv(csv, codeToId);
  if (!orders.length) return bad(res, `No usable rows. ${problems.join('; ')}`);
  const out = await orderSource.syncOrders('manual', { orders }, req.adminId);
  res.json({ success: true, data: { ...out, parseProblems: problems } });
});

router.post('/orders/sync/:source', requireRole('admin'), writeLimiter, async (req, res) => {
  const { source } = req.params;
  const { from, to } = req.body || {};
  const drivers = await repo.listDrivers({ includeInactive: true });
  try {
    const out = await orderSource.syncOrders(source, {
      from: Number.isFinite(from) ? from : Date.now() - 24 * 3600 * 1000,
      to: Number.isFinite(to) ? to : Date.now(),
      driverCodeToId: new Map(drivers.map((d) => [d.driverCode, d.id])),
    }, req.adminId);
    res.json({ success: true, data: out });
  } catch (e) {
    const status = e.code === 'NOT_CONFIGURED' ? 503 : e.code === 'UNKNOWN_SOURCE' ? 404 : 502;
    res.status(status).json({ success: false, message: e.message, code: e.code || null });
  }
});

router.get('/orders', requireRole('viewer'), async (req, res) => {
  const from = Number(req.query.from) || Date.now() - 7 * 24 * 3600 * 1000;
  const to = Number(req.query.to) || Date.now();
  const snap = await repo.C.orders().where('orderedAt', '>=', from).where('orderedAt', '<=', to).limit(1000).get();
  res.json({ success: true, data: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

// Load every processed ride in a window, with its driver, ready for reporting.
async function collectResults({ from, to, driverId }) {
  await housekeeping();
  let rides = await repo.listRides({ from, to, driverId, limit: 500 });
  // A report is only as good as the rides calculated for it. A larger budget
  // than the dashboard's, because somebody asking for a report is waiting for
  // exactly this; anything still left is named in the report's note.
  const fresh = await bringUpToDate(rides, { maxRides: 20, budgetMs: 15000 });
  if (fresh.calculated.length) rides = await repo.listRides({ from, to, driverId, limit: 500 });
  const drivers = await repo.listDrivers({ includeInactive: true });
  const byId = new Map(drivers.map((d) => [d.id, d]));
  const out = [];
  for (const ride of rides) {
    /* eslint-disable-next-line no-await-in-loop */
    const result = await repo.loadProcessing(ride.id);
    if (!result) continue;
    out.push({ ride, result, driver: byId.get(ride.driverId) || null });
  }
  return { rows: out, rides, driversById: byId };
}

const ROW_BUILDERS = {
  driver_distance: (ctx) => reports.driverDistanceRows(ctx.rows),
  business_km: (ctx) => reports.businessKmRows(ctx.rows),
  restaurant_visits: (ctx) => reports.restaurantVisitRows(ctx.rows),
  delivery_matching: (ctx) => reports.deliveryMatchingRows(ctx.rows),
  gps_reliability: (ctx) => reports.gpsReliabilityRows(ctx.rows),
  route_anomaly: (ctx) => reports.routeAnomalyRows(ctx.rows),
  classification_audit: (ctx) => reports.classificationAuditRows(ctx.reviews, ctx.driversById, ctx.ridesById),
};

async function buildReport(name, query) {
  const from = Number(query.from) || Date.now() - 7 * 24 * 3600 * 1000;
  const to = Number(query.to) || Date.now();
  const driverId = query.driverId && isValidId(query.driverId) ? query.driverId : undefined;
  const ctx = await collectResults({ from, to, driverId });
  ctx.ridesById = new Map(ctx.rides.map((r) => [r.id, r]));

  if (name === 'classification_audit') {
    const snap = await repo.C.reviews().where('at', '>=', from).where('at', '<=', to).limit(2000).get();
    ctx.reviews = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  let rows = ROW_BUILDERS[name](ctx);

  // Post-filters the report definitions share.
  if (query.restaurant) rows = rows.filter((r) => String(r.placeName || '').toLowerCase().includes(String(query.restaurant).toLowerCase()));
  if (query.confidence) rows = rows.filter((r) => !r.confidence || r.confidence === query.confidence);
  if (query.quality) rows = rows.filter((r) => !r.quality || r.quality === query.quality);
  if (query.outcome) rows = rows.filter((r) => !r.outcome || r.outcome === query.outcome);

  return {
    rows,
    meta: {
      report: name,
      title: reports.REPORTS[name].title,
      from, to, driverId: driverId || null,
      ridesIncluded: ctx.rows.length,
      ridesUnprocessed: ctx.rides.length - ctx.rows.length,
      summary: aggregateRides(ctx.rows.map((r) => r.result)),
      note: ctx.rides.length !== ctx.rows.length
        ? `${ctx.rides.length - ctx.rows.length} ride(s) in this window have not been processed and are NOT included.`
        : null,
    },
  };
}

router.get('/reports/:name', requireRole('viewer'), async (req, res) => {
  const { name } = req.params;
  if (!reports.REPORTS[name]) return res.status(404).json({ success: false, message: `Unknown report. Available: ${Object.keys(reports.REPORTS).join(', ')}` });
  const built = await buildReport(name, req.query);
  const format = String(req.query.format || 'json').toLowerCase();
  const columns = reports.REPORTS[name].columns;

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}_${new Date(built.meta.from).toISOString().slice(0, 10)}.csv"`);
    return res.send(reports.toCsv(columns, built.rows));
  }
  if (format === 'xls' || format === 'excel') {
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}_${new Date(built.meta.from).toISOString().slice(0, 10)}.xls"`);
    return res.send(reports.toExcelXml(reports.REPORTS[name].title, columns, built.rows));
  }
  return res.json({ success: true, data: { columns, ...built } });
});

// ---------------------------------------------------------------------------
// Alerts, events, audit, config
// ---------------------------------------------------------------------------

router.get('/alerts', requireRole('viewer'), async (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  const snap = await repo.C.alerts().where('status', '==', status).orderBy('raisedAt', 'desc').limit(200).get();
  res.json({ success: true, data: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
});

router.post('/alerts/:id/resolve', requireRole('manager'), writeLimiter, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return bad(res, 'Invalid alert id');
  const { note } = req.body || {};
  if (!isOptionalBoundedString(note, { max: 300 })) return bad(res, 'note is too long');
  await repo.C.alerts().doc(id).update({ status: 'resolved', resolvedAt: Date.now(), resolvedBy: `admin:${req.adminId}`, resolutionNote: note || null });
  await repo.writeAudit({ adminId: req.adminId, action: 'alert.resolve', target: id, after: { note: note || null } });
  res.json({ success: true });
});

router.get('/events', requireRole('viewer'), async (req, res) => {
  const { driverId } = req.query;
  let q = repo.C.events();
  if (driverId && isValidId(driverId)) q = q.where('driverId', '==', driverId);
  const snap = await q.orderBy('at', 'desc').limit(200).get();
  res.json({ success: true, data: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
});

router.get('/audit', requireRole('viewer'), async (req, res) => {
  const snap = await repo.C.audit().orderBy('at', 'desc').limit(200).get();
  res.json({ success: true, data: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
});

router.get('/config', requireRole('viewer'), async (req, res) => {
  const { config, rejected } = await repo.getConfig({ fresh: true });
  const { DEFAULTS, RANGES, CALC_VERSION } = require('../drivers/config');
  res.json({ success: true, data: { config, rejected, defaults: DEFAULTS, ranges: RANGES, calcVersion: CALC_VERSION } });
});

router.put('/config', requireRole('admin'), writeLimiter, async (req, res) => {
  const overrides = (req.body || {}).overrides;
  if (!overrides || typeof overrides !== 'object') return bad(res, 'overrides object is required');
  const { config, rejected } = await repo.setConfigOverrides(overrides, req.adminId);
  res.json({
    success: true,
    data: {
      config,
      rejected,
      // Changing a threshold does not retroactively change any report until the
      // affected rides are reprocessed. Saying so prevents a very confusing hour.
      note: 'Existing processed rides keep the thresholds they were calculated with. Run "Recalculate" over a date range to apply these.',
    },
  });
});

// Manual trigger for the scheduled maintenance pass (auto-close, alerts,
// processing, retention). The same code runs from Cloud Scheduler / GitHub
// Actions; this is here so an admin can force a pass and see what it did.
router.post('/maintenance/run', requireRole('admin'), writeLimiter, async (req, res) => {
  const { runMaintenance } = require('../jobs/maintenance');
  const out = await runMaintenance({ processOne, dryRunRetention: req.body?.dryRunRetention !== false });
  await repo.writeAudit({ adminId: req.adminId, action: 'maintenance.run', after: { autoClosed: out.autoClosed?.length || 0, errors: out.errors.length } });
  res.json({ success: true, data: out });
});

module.exports = { router, processOne, requireRole };
