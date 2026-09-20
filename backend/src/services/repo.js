// Firestore persistence for the Modern Drivers subsystem.
//
// This is the ONLY file in the subsystem that talks to Firestore. Everything in
// backend/src/drivers/ is pure and takes plain objects, which is what lets the
// whole calculation be re-run and tested without a database.
//
// Time convention: every domain timestamp is stored as epoch MILLISECONDS
// (a number), not a Firestore Timestamp. Pure code compares and subtracts them
// with no conversion layer, exports are unambiguous, and there is exactly one
// representation of "when". Server-side receipt times additionally get a
// Firestore serverTimestamp where an authoritative clock matters (audit rows).

const crypto = require('crypto');
const { db, admin, FieldValue } = require('./firestore');
const { resolveConfig } = require('../drivers/config');

const C = {
  drivers: () => db.collection('drivers'),
  counters: () => db.collection('counters'),
  vehicles: () => db.collection('vehicles'),
  rides: () => db.collection('rides'),
  gps: (rideId) => db.collection('rides').doc(rideId).collection('gps_raw'),
  live: () => db.collection('driver_live'),
  processing: () => db.collection('ride_processing'),
  segments: (rideId) => db.collection('ride_processing').doc(rideId).collection('segments'),
  reviews: () => db.collection('segment_reviews'),
  declarations: () => db.collection('trip_declarations'),
  restaurants: () => db.collection('restaurants'),
  facilities: () => db.collection('facilities'),
  orders: () => db.collection('delivery_orders'),
  matches: () => db.collection('delivery_matches'),
  events: () => db.collection('tracking_events'),
  alerts: () => db.collection('drivers_alerts'),
  integrationLogs: () => db.collection('integration_logs'),
  audit: () => db.collection('drivers_audit_log'),
  config: () => db.collection('drivers_config').doc('singleton'),
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let configCache = { at: 0, value: null };
const CONFIG_TTL_MS = 60000;

async function getConfig({ fresh = false } = {}) {
  if (!fresh && configCache.value && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  const doc = await C.config().get();
  const overrides = doc.exists ? (doc.data().overrides || {}) : {};
  // The raw overrides travel with the resolved config: the processing pipeline
  // resolves them itself (it is pure and owns its defaults), so handing it only
  // the resolved object would silently run it on defaults.
  const resolved = { ...resolveConfig(overrides), overrides };
  configCache = { at: Date.now(), value: resolved };
  return resolved;
}

async function setConfigOverrides(overrides, adminId) {
  const { config, rejected } = resolveConfig(overrides);
  const before = (await C.config().get()).data()?.overrides || {};
  await C.config().set({ overrides, updatedAt: Date.now(), updatedBy: adminId }, { merge: true });
  configCache = { at: 0, value: null };
  await writeAudit({ adminId, action: 'config.update', target: 'drivers_config', before, after: overrides });
  return { config, rejected };
}

// ---------------------------------------------------------------------------
// Audit / events / alerts
// ---------------------------------------------------------------------------

async function writeAudit({ adminId, action, target, before, after }) {
  await C.audit().add({
    adminId: adminId || 'system',
    action,
    target: target || null,
    before: before ?? null,
    after: after ?? null,
    at: Date.now(),
    serverAt: FieldValue.serverTimestamp(),
  });
}

async function writeEvent({ driverId, rideId, kind, detail }) {
  await C.events().add({ driverId: driverId || null, rideId: rideId || null, kind, detail: detail || null, at: Date.now() });
}

async function openAlerts(filter = {}) {
  let q = C.alerts().where('status', '==', 'open');
  if (filter.driverId) q = q.where('driverId', '==', filter.driverId);
  const snap = await q.limit(500).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Raise one alert unless an open alert with the same key already exists. This
// is what stops a condition that is true every minute (stale GPS, a revoked
// permission) from producing a row a minute until nobody reads the alert list.
async function raiseAlertOnce(alert) {
  const existing = await C.alerts().where('status', '==', 'open').where('key', '==', alert.key).limit(1).get();
  if (!existing.empty) {
    await existing.docs[0].ref.update({ lastSeenAt: Date.now(), occurrences: FieldValue.increment(1) });
    return { raised: false };
  }
  await C.alerts().add({ ...alert, status: 'open', raisedAt: Date.now(), lastSeenAt: Date.now(), occurrences: 1, resolvedAt: null, resolvedBy: null });
  return { raised: true };
}

async function applyAlertDiff({ toRaise, toResolve }, resolvedBy = 'system') {
  for (const a of toRaise) {
    // Routed through raiseAlertOnce so a re-evaluation of the same condition
    // bumps a counter instead of adding another row.
    // eslint-disable-next-line no-await-in-loop
    await raiseAlertOnce(a);
  }
  const batch = db.batch();
  for (const a of toResolve) {
    if (!a.id) continue;
    batch.update(C.alerts().doc(a.id), { status: 'resolved', resolvedAt: Date.now(), resolvedBy });
  }
  if (toResolve.length) await batch.commit();
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

// Drivers identify themselves with their name and phone number. There is no
// password and no enrolment code: a code was the previous design and it was
// wrong for this fleet — it made the office the bottleneck for every new phone
// and every replaced handset, for no security the office does not already have
// by simply looking at the driver list.
//
// The phone number IS the account. It is the document id, so two accounts for
// one number cannot exist, and a driver who reinstalls or changes handset just
// types the same number again and carries on.
//
// The honest trade-off, stated plainly because it should be a decision and not
// an accident: anyone who knows a driver's number could register as them on
// another phone. What stops that mattering is that the office sees every
// registration and every device change in the dashboard, can deactivate an
// account instantly, and that there is nothing to steal here — a false
// registration produces location data attributed to a driver who will be
// visibly in two places. If that ever stops being acceptable, an SMS one-time
// code on first registration is the upgrade, and nothing else has to change.

// Driver codes are assigned automatically, so the office never has to think of
// one. MD-001, MD-002, ... in registration order.
async function nextDriverCode() {
  const counterRef = db.collection('counters').doc('driver_code');
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const next = ((doc.exists ? doc.data().value : 0) || 0) + 1;
    tx.set(counterRef, { value: next }, { merge: true });
    return `MD-${String(next).padStart(3, '0')}`;
  });
}

const phoneId = (phone) => String(phone).replace(/\D/g, '').slice(-10);

/**
 * Register, or re-attach an existing driver on a new phone.
 * Returns { driver, created, deviceChanged }.
 */
async function registerDriver({ name, phone, deviceId, appVersion }) {
  const id = phoneId(phone);
  const ref = C.drivers().doc(id);
  const now = Date.now();

  const existing = await ref.get();
  if (existing.exists) {
    const d = existing.data();
    if (d.status !== 'active') {
      throw Object.assign(new Error('This account has been deactivated. Contact the office.'), { code: 'INACTIVE' });
    }
    const deviceChanged = !!d.deviceId && d.deviceId !== deviceId;
    await ref.update({
      deviceId,
      lastSeenAt: now,
      appVersion: appVersion || null,
      // The office's record of the name stays authoritative; what the driver
      // typed is kept beside it so a mismatch is visible rather than silently
      // overwriting either one.
      ...(String(d.name || '').trim().toLowerCase() !== String(name).trim().toLowerCase()
        ? { selfReportedName: String(name).trim().slice(0, 80) }
        : {}),
    });
    if (deviceChanged) {
      await writeEvent({ driverId: id, kind: 'device_changed', detail: { from: d.deviceId, to: deviceId } });
      await raiseAlertOnce({
        key: `device_changed|${id}|${deviceId}`,
        kind: 'device_changed',
        severity: 'info',
        driverId: id,
        detail: `${d.name || id} signed in on a different phone.`,
      });
    }
    return { driver: { id, ...d, deviceId }, created: false, deviceChanged };
  }

  const driverCode = await nextDriverCode();
  const driver = {
    name: String(name).trim().slice(0, 80),
    phone: id,
    driverCode,
    vehicleId: null,
    status: 'active',
    activeRideId: null,
    deviceId,
    appVersion: appVersion || null,
    consentAcceptedAt: now,
    createdAt: now,
    createdBy: 'self-registration',
    lastSeenAt: now,
    deactivatedAt: null,
  };
  await ref.set(driver);
  await writeEvent({ driverId: id, kind: 'driver_registered', detail: { name: driver.name, driverCode } });
  await writeAudit({ adminId: 'system:self-registration', action: 'driver.register', target: id, after: { name: driver.name, driverCode } });
  return { driver: { id, ...driver }, created: true, deviceChanged: false };
}

async function getDriver(driverId) {
  const doc = await C.drivers().doc(driverId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function listDrivers({ includeInactive = false } = {}) {
  const snap = await C.drivers().get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => includeInactive || d.status === 'active')
    .sort((a, b) => String(a.driverCode).localeCompare(String(b.driverCode)));
}

async function updateDriver(driverId, patch, adminId) {
  const before = await getDriver(driverId);
  if (!before) return null;
  await C.drivers().doc(driverId).update({ ...patch, updatedAt: Date.now() });
  await writeAudit({ adminId, action: 'driver.update', target: driverId, before, after: patch });
  return getDriver(driverId);
}

// ---------------------------------------------------------------------------
// Rides
// ---------------------------------------------------------------------------

const dayKeyFor = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10); // IST calendar day

// Start, or return the ride already running. The transaction is what makes
// "one active ride per driver" a fact rather than a hope: a double-tap, a
// retry after a timeout and two phones all converge on the same ride document.
async function startRide(driverId, meta = {}) {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const driverRef = C.drivers().doc(driverId);
    const driverDoc = await tx.get(driverRef);
    if (!driverDoc.exists) throw Object.assign(new Error('Driver not found'), { code: 'NO_DRIVER' });
    const driver = driverDoc.data();
    if (driver.status !== 'active') throw Object.assign(new Error('This driver account is not active'), { code: 'INACTIVE' });

    if (driver.activeRideId) {
      const existing = await tx.get(C.rides().doc(driver.activeRideId));
      if (existing.exists && existing.data().status === 'active') {
        return { rideId: existing.id, ...existing.data(), alreadyActive: true };
      }
    }
    // Belt and braces: the driver document could have drifted (a crash between
    // the two writes below in an older version), so also look for a stray
    // active ride before creating a new one.
    const strays = await tx.get(C.rides().where('driverId', '==', driverId).where('status', '==', 'active').limit(1));
    if (!strays.empty) {
      const d = strays.docs[0];
      tx.update(driverRef, { activeRideId: d.id });
      return { rideId: d.id, ...d.data(), alreadyActive: true };
    }

    const rideId = crypto.randomUUID();
    const ride = {
      driverId,
      driverName: driver.name,
      driverCode: driver.driverCode,
      vehicleId: driver.vehicleId || null,
      status: 'active',
      startedAt: now,
      startedBy: `driver:${driverId}`,
      dayKey: dayKeyFor(now),
      stoppedAt: null, stoppedBy: null, stopReason: null,
      lastPointAt: null, pointCount: 0,
      deviceId: meta.deviceId || null,
      appVersion: meta.appVersion || null,
      processedAt: null,
    };
    tx.set(C.rides().doc(rideId), ride);
    tx.update(driverRef, { activeRideId: rideId });
    return { rideId, ...ride, alreadyActive: false };
  });
}

// The only way a ride stops. There is deliberately no driver-callable path to
// here — see routes/driver.js, where the driver's stop endpoint exists purely
// to record the attempt and refuse it.
async function stopRide(rideId, { by, reason, kind = 'admin' }) {
  const now = Date.now();
  const result = await db.runTransaction(async (tx) => {
    const ref = C.rides().doc(rideId);
    const doc = await tx.get(ref);
    if (!doc.exists) throw Object.assign(new Error('Ride not found'), { code: 'NO_RIDE' });
    const ride = doc.data();
    if (ride.status !== 'active') return { rideId, ...ride, alreadyStopped: true };
    tx.update(ref, { status: kind === 'timeout' ? 'auto_closed' : 'stopped', stoppedAt: now, stoppedBy: by, stopReason: reason, stopKind: kind });
    tx.update(C.drivers().doc(ride.driverId), { activeRideId: null });
    return { rideId, ...ride, status: kind === 'timeout' ? 'auto_closed' : 'stopped', stoppedAt: now, alreadyStopped: false };
  });
  if (!result.alreadyStopped) {
    await writeAudit({ adminId: by, action: kind === 'timeout' ? 'ride.auto_close' : 'ride.stop', target: rideId, after: { reason, kind } });
    await writeEvent({ driverId: result.driverId, rideId, kind: 'ride_stopped', detail: { by, reason, kind } });
  }
  return result;
}

async function getRide(rideId) {
  const doc = await C.rides().doc(rideId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function activeRides() {
  const snap = await C.rides().where('status', '==', 'active').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function listRides({ driverId, from, to, status, limit = 200 }) {
  let q = C.rides();
  if (driverId) q = q.where('driverId', '==', driverId);
  if (status) q = q.where('status', '==', status);
  if (from) q = q.where('startedAt', '>=', from);
  if (to) q = q.where('startedAt', '<=', to);
  const snap = await q.orderBy('startedAt', 'desc').limit(Math.min(limit, 500)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------

// Points are written with the client's own point id as the document id, so a
// replayed batch overwrites itself instead of double-counting the kilometres.
// `create` would throw on a retry and turn a normal network retry into an
// error; a plain set of identical content is idempotent. The only field that
// changes on a replay is serverTs, which is exactly right: it records when the
// server last received the point, and the device time — the one the
// calculation uses — is unchanged.
async function ingestPoints(rideId, driverId, points) {
  if (!points.length) return { written: 0 };
  const writer = db.bulkWriter();
  const serverTs = Date.now();
  for (const p of points) {
    writer.set(
      C.gps(rideId).doc(p.clientPointId),
      { ...p, rideId, driverId, serverTs },
      { merge: false },
    );
  }
  await writer.close();

  const latest = points.reduce((a, b) => (b.deviceTs > a.deviceTs ? b : a));
  // Only move lastPointAt forward. An out-of-order replay of an old batch must
  // not make a live driver look stale.
  await db.runTransaction(async (tx) => {
    const ref = C.rides().doc(rideId);
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const cur = doc.data().lastPointAt || 0;
    tx.update(ref, {
      lastPointAt: Math.max(cur, latest.deviceTs),
      pointCount: (doc.data().pointCount || 0) + points.length,
      lastUploadAt: serverTs,
    });
  });

  // The live map reads this one document per driver. Same rule: never go
  // backwards in time.
  const liveRef = C.live().doc(driverId);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(liveRef);
    if (doc.exists && (doc.data().deviceTs || 0) > latest.deviceTs) return;
    tx.set(liveRef, {
      driverId, rideId,
      lat: latest.lat, lng: latest.lng,
      deviceTs: latest.deviceTs, serverTs,
      accuracyM: latest.accuracyM ?? null,
      speedMps: latest.speedMps ?? null,
      headingDeg: latest.headingDeg ?? null,
      batteryPct: latest.batteryPct ?? null,
      rideStatus: 'active',
    }, { merge: true });
  });

  return { written: points.length, serverTs };
}

async function loadPoints(rideId, { limit = 20000 } = {}) {
  const snap = await C.gps(rideId).orderBy('deviceTs').limit(limit).get();
  return snap.docs.map((d) => d.data());
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

let placeCache = { at: 0, facilities: null, restaurants: null };
const PLACE_TTL_MS = 5 * 60 * 1000;

async function loadPlaces({ fresh = false } = {}) {
  if (!fresh && placeCache.facilities && Date.now() - placeCache.at < PLACE_TTL_MS) {
    return { facilities: placeCache.facilities, restaurants: placeCache.restaurants };
  }
  const [fSnap, rSnap] = await Promise.all([C.facilities().get(), C.restaurants().get()]);
  const facilities = fSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.active !== false);
  const restaurants = rSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  placeCache = { at: Date.now(), facilities, restaurants };
  return { facilities, restaurants };
}

function invalidatePlaceCache() { placeCache = { at: 0, facilities: null, restaurants: null }; }

// ---------------------------------------------------------------------------
// Orders, declarations, reviews, processing results
// ---------------------------------------------------------------------------

async function ordersForRide(ride) {
  // Orders for the ride's calendar day. Both the driver's own and any order to
  // a customer they visited — the second kind is how a mis-assignment is found,
  // so restricting the query to assignedDriverId would hide the problem.
  const dayStart = Date.parse(`${ride.dayKey}T00:00:00+05:30`);
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const snap = await C.orders()
    .where('orderedAt', '>=', dayStart - 12 * 3600 * 1000)
    .where('orderedAt', '<', dayEnd)
    .limit(2000)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function declarationsForRide(rideId) {
  const snap = await C.declarations().where('rideId', '==', rideId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function reviewsForRide(rideId) {
  const snap = await C.reviews().where('rideId', '==', rideId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.at - b.at);
}

// Reviews are append-only. Superseding an earlier decision marks the earlier
// row `superseded`; it is never edited away, so the chain of who decided what,
// when and why survives intact.
async function addReview({ rideId, segmentId, fromType, toType, distanceM, note, reviewerId, segStartTs, segEndTs }) {
  const prior = await C.reviews().where('rideId', '==', rideId).where('segmentId', '==', segmentId).where('reverted', '==', false).get();
  const batch = db.batch();
  for (const doc of prior.docs) batch.update(doc.ref, { superseded: true });
  const ref = C.reviews().doc();
  batch.set(ref, {
    rideId, segmentId, fromType, toType, distanceM: distanceM ?? null,
    // The time window this decision was made against. Segment ids are
    // positional, so without this a reprocess could re-attach the decision to a
    // different stretch of the day. classification.js refuses to apply a review
    // whose window no longer matches.
    segStartTs: segStartTs ?? null, segEndTs: segEndTs ?? null,
    note: note || null, reviewerId, at: Date.now(), reverted: false, superseded: false,
  });
  await batch.commit();
  await writeAudit({ adminId: reviewerId, action: 'segment.reclassify', target: `${rideId}/${segmentId}`, before: { type: fromType }, after: { type: toType, note } });
  return { id: ref.id };
}

async function revertReview(reviewId, reviewerId) {
  const ref = C.reviews().doc(reviewId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  await ref.update({ reverted: true, revertedBy: reviewerId, revertedAt: Date.now() });
  await writeAudit({ adminId: reviewerId, action: 'segment.revert_review', target: reviewId, before: doc.data() });
  return { id: reviewId };
}

async function saveProcessing(rideId, result) {
  const { segments, ...head } = result;
  await C.processing().doc(rideId).set({ ...head, processedAt: Date.now() }, { merge: false });
  // Segments live in a sub-collection: a ride can have hundreds, and Firestore
  // caps a document at 1 MiB.
  const writer = db.bulkWriter();
  for (const seg of segments) writer.set(C.segments(rideId).doc(seg.id), seg, { merge: false });
  await writer.close();
  await C.rides().doc(rideId).update({ processedAt: Date.now(), calcVersion: result.calcVersion });

  // Matches are queryable on their own for the matching report.
  const mWriter = db.bulkWriter();
  for (const m of result.matching.matches) {
    mWriter.set(C.matches().doc(`${rideId}_${m.segmentId}_${m.orderId}`), { rideId, driverId: result.driverId, ...m }, { merge: false });
  }
  await mWriter.close();
}

async function loadProcessing(rideId, { withSegments = true } = {}) {
  const doc = await C.processing().doc(rideId).get();
  if (!doc.exists) return null;
  const head = doc.data();
  if (!withSegments) return head;
  const segs = await C.segments(rideId).orderBy('index').get();
  return { ...head, segments: segs.docs.map((d) => d.data()) };
}

module.exports = {
  C, dayKeyFor,
  getConfig, setConfigOverrides,
  writeAudit, writeEvent, openAlerts, applyAlertDiff, raiseAlertOnce,
  registerDriver, getDriver, listDrivers, updateDriver, nextDriverCode, phoneId,
  startRide, stopRide, getRide, activeRides, listRides,
  ingestPoints, loadPoints,
  loadPlaces, invalidatePlaceCache,
  ordersForRide, declarationsForRide, reviewsForRide, addReview, revertReview,
  saveProcessing, loadProcessing,
  admin,
};
