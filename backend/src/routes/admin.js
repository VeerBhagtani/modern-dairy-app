// Admin API for the office dashboard. Mounted at /admin, behind requireAdmin().
//
// Role model on top of requireAdmin():
//   admin    everything, including config, driver accounts and deletion
//   manager  view + review classifications + stop rides
//   viewer   read only
//
// Roles come from the admin's own account (admins/{username}) and ride on the
// signed token, so a role change takes effect at the next sign-in.

const router = require('express').Router();
const repo = require('../services/repo');
const { db } = require('../services/firestore');
const { writeLimiter } = require('../middleware/rateLimit');
const {
  isValidId, isBoundedString, isOptionalBoundedString, pickAllowed, hasForbiddenKeys,
} = require('../middleware/validate');
const { processRideData, aggregateRides } = require('../drivers/pipeline');
const { SEGMENT_TYPE } = require('../drivers/classification');
const { evaluateResultAlerts } = require('../drivers/alerts');
const reports = require('../drivers/reports');
const orderSource = require('../services/orderSource');
const manual = require('../services/orderSource/manual');

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

  const [drivers, rides, liveSnap, alerts] = await Promise.all([
    repo.listDrivers({ includeInactive: true }),
    repo.listRides({ from: Date.parse(`${today}T00:00:00+05:30`), limit: 500 }),
    repo.C.live().get(),
    repo.openAlerts(),
  ]);
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
    for (const r of driverRides) {
      const res2 = resultByRide.get(r.id);
      if (!res2) continue;
      calculated = true;
      verified = (verified || 0) + res2.distance.metres.verifiedBusiness;
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
        unknownKm: unknown == null ? null : Math.round(unknown / 100) / 10,
      },
    };
  });

  res.json({
    success: true,
    data: {
      serverTime: now,
      staleAfterSec: config.staleLocationSec,
      drivers: rows,
      metrics: {
        activeDrivers: rows.filter((r) => r.rideStatus === 'active').length,
        completedRides: rides.filter((r) => r.status !== 'active').length,
        totalKm: Math.round(rows.reduce((s, r) => s + (r.today.totalKm || 0), 0) * 10) / 10,
        verifiedBusinessKm: Math.round(rows.reduce((s, r) => s + (r.today.verifiedBusinessKm || 0), 0) * 10) / 10,
        unknownKm: Math.round(rows.reduce((s, r) => s + (r.today.unknownKm || 0), 0) * 10) / 10,
        trackingIssues: rows.filter((r) => ['no_signal', 'degraded'].includes(r.trackingHealth)).length,
        openAlerts: alerts.length,
        unprocessedRides: rides.filter((r) => r.status !== 'active' && !resultByRide.get(r.id)).length,
      },
      alerts: alerts.slice(0, 50),
    },
  });
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

router.get('/list', requireRole('viewer'), async (req, res) => {
  res.json({ success: true, data: await repo.listDrivers({ includeInactive: req.query.all === '1' }) });
});

// Drivers are not created here — they register themselves in the app with
// their name and phone number, and appear in this list the moment they do.
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
  const ride = await repo.getRide(rideId);
  if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
  const [processing, points, declarations, reviews] = await Promise.all([
    repo.loadProcessing(rideId),
    req.query.points === '1' ? repo.loadPoints(rideId) : Promise.resolve(null),
    repo.declarationsForRide(rideId),
    repo.reviewsForRide(rideId),
  ]);
  res.json({
    success: true,
    data: {
      ride,
      processing,
      // Raw points, exactly as uploaded. Processing never edits these, and the
      // replay map draws from them so a reviewer sees the real track.
      points,
      declarations,
      reviews,
      processingNote: processing ? null : 'This ride has not been processed yet. No distance has been calculated.',
    },
  });
});

// THE remote stop. A reason is mandatory — an unexplained stop in a location
// log is exactly the kind of record that cannot be defended later.
router.post('/rides/:rideId/stop', requireRole('manager'), writeLimiter, async (req, res) => {
  const { rideId } = req.params;
  const { reason, emergency } = req.body || {};
  if (!isValidId(rideId)) return bad(res, 'Invalid ride id');
  if (!isBoundedString(reason, { min: 3, max: 300 })) return bad(res, 'Give a reason for stopping this ride (at least 3 characters).');
  try {
    const out = await repo.stopRide(rideId, {
      by: `admin:${req.adminId}`,
      reason: emergency === true ? `EMERGENCY STOP: ${reason}` : reason,
      kind: emergency === true ? 'emergency' : 'admin',
    });
    // Mark the live document so the map stops showing an active marker even
    // before the phone next checks in.
    await repo.C.live().doc(out.driverId).set({ rideStatus: 'stopped', rideStoppedAt: Date.now() }, { merge: true }).catch(() => {});
    res.json({ success: true, data: out });
  } catch (e) {
    if (e.code === 'NO_RIDE') return res.status(404).json({ success: false, message: 'Ride not found' });
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

// Re-run the whole calculation for one ride. Safe to call any number of times:
// it reads the immutable raw points and REPLACES the processed result, so a
// threshold change or a new review is picked up without touching the GPS data.
async function processOne(rideId) {
  const ride = await repo.getRide(rideId);
  if (!ride) throw Object.assign(new Error('Ride not found'), { code: 'NO_RIDE' });
  const [{ config, overrides }, points, places, orders, declarations, reviews] = await Promise.all([
    repo.getConfig(),
    repo.loadPoints(rideId),
    repo.loadPlaces(),
    repo.ordersForRide(ride),
    repo.declarationsForRide(rideId),
    repo.reviewsForRide(rideId),
  ]);
  const result = processRideData({
    points,
    ride: { id: rideId, driverId: ride.driverId, startedAt: ride.startedAt, stoppedAt: ride.stoppedAt },
    facilities: places.facilities,
    restaurants: places.restaurants,
    orders,
    declarations,
    reviews: reviews.filter((r) => !r.reverted && !r.superseded),
    configOverrides: overrides,
    nowMs: Date.now(),
  });
  await repo.saveProcessing(rideId, result);

  const existing = await repo.openAlerts({ driverId: ride.driverId });
  const desired = evaluateResultAlerts(ride, result, config);
  await repo.applyAlertDiff({
    toRaise: desired,
    // Only result-derived alerts are reconciled here; live-tracking alerts have
    // their own lifecycle in the maintenance job.
    toResolve: existing.filter((a) => a.rideId === rideId && ['large_gap', 'unmatched_delivery', 'segment_needs_review'].includes(a.kind) && !desired.some((d) => d.key === a.key)),
  });
  return result;
}

router.post('/rides/:rideId/process', requireRole('manager'), writeLimiter, async (req, res) => {
  const { rideId } = req.params;
  if (!isValidId(rideId)) return bad(res, 'Invalid ride id');
  try {
    const result = await processOne(rideId);
    await repo.writeAudit({ adminId: req.adminId, action: 'ride.reprocess', target: rideId, after: { calcVersion: result.calcVersion, verifiedBusinessKm: result.distance.km.verifiedBusiness } });
    res.json({ success: true, data: result });
  } catch (e) {
    if (e.code === 'NO_RIDE') return res.status(404).json({ success: false, message: 'Ride not found' });
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
  const result = await processOne(rideId);
  res.json({ success: true, data: { distance: result.distance, segment: result.segments.find((s) => s.id === segmentId) } });
});

router.post('/reviews/:reviewId/revert', requireRole('manager'), writeLimiter, async (req, res) => {
  const { reviewId } = req.params;
  if (!isValidId(reviewId)) return bad(res, 'Invalid review id');
  const doc = await repo.C.reviews().doc(reviewId).get();
  if (!doc.exists) return res.status(404).json({ success: false, message: 'Review not found' });
  await repo.revertReview(reviewId, `admin:${req.adminId}`);
  const result = await processOne(doc.data().rideId);
  res.json({ success: true, data: { distance: result.distance } });
});

// ---------------------------------------------------------------------------
// Places: restaurants and Modern Dairy facilities
// ---------------------------------------------------------------------------

function validatePlace(body, { isFacility }) {
  const p = pickAllowed(body, ['name', 'customerId', 'address', 'lat', 'lng', 'radiusM', 'active', 'area', 'schedule', 'externalId', 'isStartPoint', 'notes']);
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
    res.json({ success: true, data: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  });

  router.post(`/${path}`, requireRole('admin'), writeLimiter, async (req, res) => {
    const { place, error } = validatePlace(req.body || {}, { isFacility });
    if (error) return bad(res, error);
    const ref = repo.C[colName]().doc();
    await ref.set({ ...place, createdAt: Date.now(), createdBy: req.adminId });
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
    await ref.set({ ...place, updatedAt: Date.now(), updatedBy: req.adminId }, { merge: true });
    repo.invalidatePlaceCache();
    await repo.writeAudit({ adminId: req.adminId, action: `${path}.update`, target: id, before: before.data(), after: place });
    res.json({ success: true, data: { id, ...place } });
  });
}

// CSV import for restaurants. Rows that cannot be trusted are REPORTED, never
// guessed at: a restaurant imported to the wrong coordinates silently poisons
// every classification that touches it.
router.post('/restaurants/import', requireRole('admin'), writeLimiter, async (req, res) => {
  const { csv } = req.body || {};
  if (!isBoundedString(csv, { min: 1, max: 2_000_000 })) return bad(res, 'csv is required');
  const rows = manual.parseCsv(csv);
  if (rows.length < 2) return bad(res, 'The file has no data rows.');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = (n) => header.indexOf(n);
  for (const required of ['name', 'lat', 'lng']) {
    if (col(required) === -1) return bad(res, `Missing required column "${required}"`);
  }
  const imported = []; const problems = [];
  const writer = db.bulkWriter();
  for (let r = 1; r < rows.length; r += 1) {
    const at = (n) => (col(n) === -1 ? null : (rows[r][col(n)] ?? '').trim());
    const candidate = {
      name: at('name'),
      customerId: at('customer_id') || null,
      address: at('address') || null,
      lat: Number(at('lat')),
      lng: Number(at('lng')),
      radiusM: at('radius_m') ? Number(at('radius_m')) : null,
      area: at('area') || null,
      externalId: at('external_id') || null,
      schedule: at('schedule') || null,
      active: at('active') ? !/^(0|no|false|inactive)$/i.test(at('active')) : true,
    };
    const { place, error } = validatePlace(candidate, { isFacility: false });
    if (error) { problems.push({ row: r + 1, error, name: candidate.name }); continue; }
    // An external id makes the import idempotent: re-uploading a corrected file
    // updates the same records instead of creating a second set.
    const id = candidate.externalId ? `ext_${candidate.externalId.replace(/[^A-Za-z0-9_-]/g, '_')}` : undefined;
    const ref = id ? repo.C.restaurants().doc(id) : repo.C.restaurants().doc();
    writer.set(ref, { ...place, importedAt: Date.now(), importedBy: req.adminId }, { merge: true });
    imported.push(ref.id);
  }
  await writer.close();
  repo.invalidatePlaceCache();
  await repo.writeAudit({ adminId: req.adminId, action: 'restaurants.import', after: { imported: imported.length, problems: problems.length } });
  res.json({ success: true, data: { imported: imported.length, problems } });
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
  const rides = await repo.listRides({ from, to, driverId, limit: 500 });
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

module.exports = { router, processOne, requireRole, roleOf };
