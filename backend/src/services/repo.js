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
const { readAll } = require('./paging');
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
  routeCache: () => db.collection('route_cache'),
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

/* The Locations lock.
 *
 * Once the restaurant list is right, the office wants it to stay right. The
 * expensive mistakes on that screen are all one click and thousands of rows
 * wide — re-importing an old spreadsheet, re-running a lookup that moves pins
 * somebody spent an afternoon placing. This is the latch that stops a passing
 * hand from doing any of them.
 *
 * Enforced on the server, not by disabling buttons: a greyed-out button is a
 * suggestion, and this needs to be a rule.
 */
async function getLocationsLock() {
  const doc = await C.config().get();
  const d = doc.exists ? doc.data() : {};
  return {
    locked: d.locationsLocked === true,
    lockedAt: d.locationsLockedAt || null,
    lockedBy: d.locationsLockedBy || null,
  };
}

async function setLocationsLock(locked, adminId) {
  const before = await getLocationsLock();
  await C.config().set({
    locationsLocked: !!locked,
    locationsLockedAt: locked ? Date.now() : null,
    locationsLockedBy: locked ? adminId : null,
  }, { merge: true });
  await writeAudit({
    adminId,
    action: locked ? 'locations.lock' : 'locations.unlock',
    target: 'drivers_config',
    before: { locked: before.locked },
    after: { locked: !!locked },
  });
  return getLocationsLock();
}

/* The people who stop rides.
 *
 * Stopping a ride asks who did it, from a list the office keeps: the
 * signed-in account says which login was used, not which person at the desk
 * pressed the button, and a shared office login is normal here. Kept on the
 * config document with the other office settings.
 */
const MAX_STOP_NAMES = 100;
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60);

async function getStopNames() {
  const doc = await C.config().get();
  const list = doc.exists && Array.isArray(doc.data().stopNames) ? doc.data().stopNames : [];
  return list.filter((n) => typeof n === 'string' && n.trim());
}

async function addStopName(name, adminId) {
  const clean = cleanName(name);
  if (clean.length < 2) throw Object.assign(new Error('Enter a name of at least two letters.'), { code: 'BAD_NAME' });
  const names = await db.runTransaction(async (tx) => {
    const ref = C.config();
    const doc = await tx.get(ref);
    const list = doc.exists && Array.isArray(doc.data().stopNames) ? doc.data().stopNames : [];
    // The same person typed twice, in another case, is one person.
    if (list.some((n) => n.toLowerCase() === clean.toLowerCase())) return list;
    if (list.length >= MAX_STOP_NAMES) throw Object.assign(new Error('The list is full. Remove a name first.'), { code: 'FULL' });
    const next = [...list, clean].sort((a, b) => a.localeCompare(b));
    tx.set(ref, { stopNames: next }, { merge: true });
    return next;
  });
  await writeAudit({ adminId, action: 'stop_names.add', target: 'drivers_config', after: { name: clean } });
  return names;
}

async function removeStopName(name, adminId) {
  const clean = cleanName(name);
  const names = await db.runTransaction(async (tx) => {
    const ref = C.config();
    const doc = await tx.get(ref);
    const list = doc.exists && Array.isArray(doc.data().stopNames) ? doc.data().stopNames : [];
    const next = list.filter((n) => n.toLowerCase() !== clean.toLowerCase());
    tx.set(ref, { stopNames: next }, { merge: true });
    return next;
  });
  await writeAudit({ adminId, action: 'stop_names.remove', target: 'drivers_config', before: { name: clean } });
  return names;
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

// A driver types their NAME. That is the whole sign-in.
//
// The phone is the account: the device id the app generates on first launch is
// the document id, so the same handset is always the same driver and a name is
// a label on it rather than a credential. Two drivers called Ramesh on two
// phones are two accounts, which is correct.
//
// There is no password, no code and no phone number, because none of them were
// earning their place. A code made the office the bottleneck for every new
// handset. A phone number is not a secret either — it just looked like one.
// What actually protects this is the office: it sees every registration in the
// dashboard and can switch any account off instantly, and the data a false
// registration would produce is a journey attributed to someone who is visibly
// somewhere else. If that ever stops being enough, an SMS code at registration
// is the upgrade and nothing else has to change.

// Driver codes are assigned automatically so the office never invents one.
async function nextDriverCode() {
  const counterRef = db.collection('counters').doc('driver_code');
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const next = ((doc.exists ? doc.data().value : 0) || 0) + 1;
    tx.set(counterRef, { value: next }, { merge: true });
    return `MD-${String(next).padStart(3, '0')}`;
  });
}

/**
 * Register this phone, or update the name on one already known.
 * @returns {{ driver, created }}
 */
async function registerDriver({ name, deviceId, appVersion }) {
  const ref = C.drivers().doc(deviceId);
  const now = Date.now();
  const existing = await ref.get();

  if (existing.exists) {
    const d = existing.data();
    if (d.status !== 'active') {
      throw Object.assign(new Error('This phone has been switched off by the office.'), { code: 'INACTIVE' });
    }
    const patch = { lastSeenAt: now, appVersion: appVersion || null };
    // A name change is allowed — a phone gets handed to a different driver —
    // but it is recorded, because "who was driving" is the whole point.
    if (String(d.name || '').trim() !== String(name).trim()) {
      patch.name = String(name).trim().slice(0, 80);
      patch.previousNames = [...(d.previousNames || []), { name: d.name, until: now }].slice(-10);
      await writeEvent({ driverId: deviceId, kind: 'name_changed', detail: { from: d.name, to: patch.name } });
    }
    await ref.update(patch);
    return { driver: { id: deviceId, ...d, ...patch }, created: false };
  }

  const driverCode = await nextDriverCode();
  const driver = {
    name: String(name).trim().slice(0, 80),
    driverCode,
    deviceId,
    phone: null,
    vehicleId: null,
    status: 'active',
    activeRideId: null,
    appVersion: appVersion || null,
    consentAcceptedAt: now,
    createdAt: now,
    createdBy: 'self-registration',
    lastSeenAt: now,
    deactivatedAt: null,
  };
  await ref.set(driver);
  await writeEvent({ driverId: deviceId, kind: 'driver_registered', detail: { name: driver.name, driverCode } });
  await writeAudit({ adminId: 'system:self-registration', action: 'driver.register', target: deviceId, after: { name: driver.name, driverCode } });
  return { driver: { id: deviceId, ...driver }, created: true };
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
// The last millisecond of an IST calendar day.
const endOfDayMs = (dayKey) => Date.parse(`${dayKey}T23:59:59.999+05:30`);
const DAY_END_REASON = (dayKey) => `The day ${dayKey} ended. Each day is kept as its own ride.`;

/* One ride per day.
 *
 * Only the office stops a ride, and nobody stops every ride every evening, so
 * rides used to run on for days: Start Ride the next morning returned the same
 * ride, and a week of driving became one ride with one total. A ride now ends
 * with its day. It is closed at the end of that day — not when somebody next
 * notices — so its points up to midnight stay in it and later ones are refused
 * from it and go to the next day's ride instead.
 *
 * Called from every place that touches an active ride (the phone starting,
 * checking and uploading; the dashboard looking), because there is no
 * scheduler to do it at midnight. Returns the closed ride, or null if the ride
 * was not over.
 */
async function closeIfDayOver(ride, nowMs = Date.now()) {
  if (!ride || ride.status !== 'active' || !ride.dayKey) return null;
  if (ride.dayKey >= dayKeyFor(nowMs)) return null;
  const id = ride.id || ride.rideId;
  const out = await stopRide(id, {
    by: 'system:day_end',
    reason: DAY_END_REASON(ride.dayKey),
    kind: 'day_end',
    stoppedAt: Math.min(nowMs, endOfDayMs(ride.dayKey)),
  });
  await C.live().doc(ride.driverId).set({ rideStatus: 'day_closed', rideStoppedAt: out.stoppedAt }, { merge: true }).catch(() => {});
  return { id, ...out };
}

// Start, or return the ride already running. The transaction is what makes
// "one active ride per driver" a fact rather than a hope: a double-tap, a
// retry after a timeout and two phones all converge on the same ride document.
async function startRide(driverId, meta = {}) {
  const now = Date.now();
  // Rides closed below because their day had ended. Audited after the
  // transaction commits: every ride stop is on the record, whoever made it.
  let closedForDayEnd = [];
  const out = await db.runTransaction(async (tx) => {
    closedForDayEnd = [];   // a transaction can be retried; start clean each time
    const driverRef = C.drivers().doc(driverId);
    const driverDoc = await tx.get(driverRef);
    if (!driverDoc.exists) throw Object.assign(new Error('Driver not found'), { code: 'NO_DRIVER' });
    const driver = driverDoc.data();
    if (driver.status !== 'active') throw Object.assign(new Error('This driver account is not active'), { code: 'INACTIVE' });

    // An active ride from an earlier day is closed at the end of its day, in
    // this same transaction, and today gets a new ride. Only a ride from today
    // is carried on.
    const today = dayKeyFor(now);
    const closeOld = (ref, data) => {
      tx.update(ref, {
        status: STOP_STATUS.day_end, stoppedAt: Math.min(now, endOfDayMs(data.dayKey)),
        stoppedBy: 'system:day_end', stopReason: DAY_END_REASON(data.dayKey), stopKind: 'day_end',
      });
      closedForDayEnd.push({ rideId: ref.id, dayKey: data.dayKey });
    };

    // Reads first: a Firestore transaction must do all its reads before any
    // write.
    const existing = driver.activeRideId ? await tx.get(C.rides().doc(driver.activeRideId)) : null;
    // Belt and braces: the driver document could have drifted (a crash between
    // the two writes below in an older version), so also look for a stray
    // active ride before creating a new one.
    const strays = await tx.get(C.rides().where('driverId', '==', driverId).where('status', '==', 'active').limit(5));

    const open = [];
    if (existing && existing.exists && existing.data().status === 'active') open.push(existing);
    for (const d of strays.docs) if (!open.some((o) => o.id === d.id)) open.push(d);
    const current = open.find((d) => (d.data().dayKey || today) >= today);
    for (const d of open) if (d !== current) closeOld(d.ref, d.data());
    if (current) {
      if (driver.activeRideId !== current.id) tx.update(driverRef, { activeRideId: current.id });
      return { rideId: current.id, ...current.data(), alreadyActive: true };
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
  for (const c of closedForDayEnd) {
    const reason = DAY_END_REASON(c.dayKey);
    /* eslint-disable no-await-in-loop */
    await writeAudit({ adminId: 'system:day_end', action: 'ride.day_end', target: c.rideId, after: { reason, kind: 'day_end' } }).catch(() => {});
    await writeEvent({ driverId, rideId: c.rideId, kind: 'ride_stopped', detail: { by: 'system:day_end', reason, kind: 'day_end' } }).catch(() => {});
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

// The only way a ride stops. There is deliberately no driver-callable path to
// here — see routes/driver.js, where the driver's stop endpoint exists purely
// to record the attempt and refuse it.
// Status each kind of stop leaves behind. A day-end close is neither the
// office's decision nor a timeout, and reports say which it was.
const STOP_STATUS = { timeout: 'auto_closed', day_end: 'day_closed' };

async function stopRide(rideId, { by, reason, kind = 'admin', stoppedAt = null, byName = null }) {
  // A day-end close is stamped at the end of the ride's day, not at the moment
  // somebody happened to notice the day was over: points recorded up to
  // midnight belong to that day, and anything later is refused from it.
  const now = stoppedAt || Date.now();
  const result = await db.runTransaction(async (tx) => {
    const ref = C.rides().doc(rideId);
    const doc = await tx.get(ref);
    if (!doc.exists) throw Object.assign(new Error('Ride not found'), { code: 'NO_RIDE' });
    const ride = doc.data();
    if (ride.status !== 'active') return { rideId, ...ride, alreadyStopped: true };
    const status = STOP_STATUS[kind] || 'stopped';
    // byName: the person at the office who stopped it, chosen from the list.
    tx.update(ref, { status, stoppedAt: now, stoppedBy: by, stoppedByName: byName, stopReason: reason, stopKind: kind });
    tx.update(C.drivers().doc(ride.driverId), { activeRideId: null });
    return { rideId, ...ride, status, stoppedAt: now, stopKind: kind, alreadyStopped: false };
  });
  if (!result.alreadyStopped) {
    await writeAudit({ adminId: by, action: kind === 'timeout' ? 'ride.auto_close' : kind === 'day_end' ? 'ride.day_end' : 'ride.stop', target: rideId, after: { reason, kind, byName } });
    await writeEvent({ driverId: result.driverId, rideId, kind: 'ride_stopped', detail: { by, byName, reason, kind } });
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
  if (!points.length) return { written: 0, duplicates: 0 };
  const writer = db.bulkWriter();
  const serverTs = Date.now();
  // create(), not set(): a point that is already stored (the same batch sent
  // again after a lost reply) is left exactly as it was, and not counted
  // twice. The clientPointId is the document id, so a retry can never make a
  // second copy.
  let duplicates = 0;
  writer.onWriteError((err) => {
    if (err.code === 6 /* ALREADY_EXISTS */) { duplicates += 1; return false; }
    return err.failedAttempts < 3;
  });
  const writes = points.map((p) => writer.create(C.gps(rideId).doc(p.clientPointId), { ...p, rideId, driverId, serverTs })
    .then(() => true, (err) => { if (err.code === 6) return false; throw err; }));
  await writer.close();
  const results = await Promise.all(writes);
  const written = results.filter(Boolean).length;
  if (!written) return { written: 0, duplicates };

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
      pointCount: (doc.data().pointCount || 0) + written,
      // Stamped now, after the points above are committed, not at the start of
      // the upload: a calculation that read the points in between must still
      // see this ride as having newer data than it used.
      lastUploadAt: Date.now(),
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

  return { written, duplicates, serverTs };
}

// Every point of the ride, page by page. There is deliberately no cap: a
// capped read silently dropped the end of a long ride (or of a phone that
// sampled fast), and the kilometres after the cap simply disappeared.
const POINT_PAGE = 5000;
async function loadPoints(rideId) {
  // Paged after the last document itself (deviceTs, then document id), so two
  // fixes in the same millisecond can never be skipped at a page edge, and no
  // extra index is needed.
  return readAll((after) => {
    const q = C.gps(rideId).orderBy('deviceTs').limit(POINT_PAGE);
    return after ? q.startAfter(after) : q;
  }, POINT_PAGE);
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
  // A restaurant only reaches the classification engine once it has real,
  // confirmed coordinates. Rows imported from a spreadsheet without a location,
  // and geocoder guesses nobody has checked, are deliberately invisible here:
  // an unconfirmed pin is a geofence in the wrong place, and a geofence in the
  // wrong place turns somebody's own errand into billable distance. They are
  // listed in the dashboard for review instead.
  const restaurants = rSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
      && p.locationStatus !== 'pending' && p.locationStatus !== 'unconfirmed');
  placeCache = { at: Date.now(), facilities, restaurants };
  return { facilities, restaurants };
}

function invalidatePlaceCache() { placeCache = { at: 0, facilities: null, restaurants: null }; }

// ---------------------------------------------------------------------------
// Learned road knowledge
// ---------------------------------------------------------------------------
//
// What each driver's own trips have taught us about the roads between two
// restaurants, and the orders they habitually visit them in. This is written
// once per ride, when the ride is processed, and read when a driver asks for a
// plan — so planning stays a couple of document reads rather than a scan of a
// year of GPS.
//
// Kept per driver on purpose. The whole value of it is that driver 12 and
// driver 31 do not drive the same roads, and averaging them away would leave
// exactly the fleet-wide answer Google already gives for free.

const LEG_LIMIT_PER_DRIVER = 400;   // a driver covering 400 distinct legs is not real
const RUNS_KEPT_PER_LEG = 12;       // enough for a stable median, cheap to store
const SEQUENCES_KEPT = 60;          // roughly three months of working days

// A driver's named rounds ("Camp round"): the set of restaurants they plan
// together, saved so the same round is one tap next time. One document per
// driver; there are only ever a handful.
const MAX_ROUNDS = 30;
function roundsDoc(driverId) { return db.collection('driver_rounds').doc(driverId); }
async function getRounds(driverId) {
  const doc = await roundsDoc(driverId).get();
  return (doc.exists && Array.isArray(doc.data().rounds)) ? doc.data().rounds : [];
}
/* Saved under its name: the same name (any case) replaces the old stops. */
async function saveRound(driverId, { name, stopIds }) {
  return db.runTransaction(async (tx) => {
    const ref = roundsDoc(driverId);
    const doc = await tx.get(ref);
    const rounds = (doc.exists && Array.isArray(doc.data().rounds)) ? doc.data().rounds : [];
    const key = name.toLowerCase();
    const existing = rounds.find((r) => r.name.toLowerCase() === key);
    const now = Date.now();
    let saved;
    if (existing) { existing.name = name; existing.stopIds = stopIds; existing.updatedAt = now; saved = existing; }
    else {
      if (rounds.length >= MAX_ROUNDS) throw Object.assign(new Error(`You can keep up to ${MAX_ROUNDS} rounds. Delete one first.`), { status: 400 });
      saved = { id: `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, stopIds, createdAt: now, updatedAt: now };
      rounds.push(saved);
    }
    tx.set(ref, { driverId, rounds, updatedAt: now });
    return { saved, rounds };
  });
}
async function deleteRound(driverId, roundId) {
  return db.runTransaction(async (tx) => {
    const ref = roundsDoc(driverId);
    const doc = await tx.get(ref);
    const rounds = (doc.exists && Array.isArray(doc.data().rounds)) ? doc.data().rounds : [];
    const left = rounds.filter((r) => r.id !== roundId);
    tx.set(ref, { driverId, rounds: left, updatedAt: Date.now() });
    return left;
  });
}

function legsDoc(driverId) { return db.collection('driver_legs').doc(driverId); }

async function loadDriverLegs(driverId) {
  const doc = await legsDoc(driverId).get();
  if (!doc.exists) return { legs: {}, sequences: [] };
  const d = doc.data();
  return { legs: d.legs || {}, sequences: d.sequences || [] };
}

/* Fold one ride's observations into what we know about this driver.
 *
 * Only the most recent runs of each leg are kept. A driver's roads change —
 * a flyover opens, a shift moves to mornings — and an estimate that averages
 * in last year's traffic is not the estimate to plan tomorrow around.
 */
async function recordDriverLegs(driverId, observations, sequence, { rideId = null } = {}) {
  if (!driverId) return { legs: 0, sequences: 0 };
  const current = await loadDriverLegs(driverId);
  const legs = { ...current.legs };

  for (const o of observations || []) {
    const key = `${o.from}>${o.to}`;
    const run = { distanceM: o.distanceM, durationS: o.durationS, at: o.at };
    if (rideId) run.rideId = rideId;

    // A ride is processed more than once: on finishing, on a manual
    // recalculation, and again after every segment review. Appending blindly
    // meant one trip could become five identical observations, and five is
    // exactly the count at which legCost stops blending and starts telling the
    // driver a leg is "measured from your 5 past trips". A recalculation must
    // not manufacture confidence, so an observation replaces the one it is a
    // re-reading of rather than joining it.
    const kept = (legs[key] || []).filter((r) => (
      rideId && r.rideId ? r.rideId !== rideId : !(r.at === run.at && r.distanceM === run.distanceM)
    ));

    const runs = [...kept, run];
    runs.sort((a, b) => (b.at || 0) - (a.at || 0));
    legs[key] = runs.slice(0, RUNS_KEPT_PER_LEG);
  }

  // If a driver somehow exceeds the cap, drop the legs nobody has driven
  // lately rather than refusing to learn anything new.
  const keys = Object.keys(legs);
  if (keys.length > LEG_LIMIT_PER_DRIVER) {
    const freshest = (k) => Math.max(0, ...legs[k].map((r) => r.at || 0));
    for (const k of keys.sort((a, b) => freshest(a) - freshest(b)).slice(0, keys.length - LEG_LIMIT_PER_DRIVER)) {
      delete legs[k];
    }
  }

  // Same for the visit order: a reprocess must not make one day's round look
  // like a habit repeated three times, because that is what the planner reads
  // to decide whether to leave a driver's routine alone.
  const sequences = [...current.sequences].filter((s) => !(rideId && s.rideId === rideId));
  if (sequence && sequence.length >= 2) {
    sequences.unshift({ order: sequence, at: Date.now(), rideId: rideId || null });
  }

  await legsDoc(driverId).set({
    legs,
    sequences: sequences.slice(0, SEQUENCES_KEPT),
    updatedAt: Date.now(),
  }, { merge: true });

  return { legs: Object.keys(legs).length, sequences: sequences.length };
}

/* What the rest of the fleet knows about a leg this driver has never driven.
 *
 * A weaker signal than the driver's own history — somebody else's shortcut may
 * not be one they can use — but far better than a straight line, and it costs
 * nothing. Cached: it changes slowly and is read on every plan.
 */
let fleetCache = { at: 0, value: null };
const FLEET_TTL_MS = 30 * 60 * 1000;

async function loadFleetLegs({ fresh = false } = {}) {
  if (!fresh && fleetCache.value && Date.now() - fleetCache.at < FLEET_TTL_MS) return fleetCache.value;
  const snap = await db.collection('driver_legs').get();
  const acc = {};
  for (const doc of snap.docs) {
    for (const [key, runs] of Object.entries(doc.data().legs || {})) {
      (acc[key] = acc[key] || []).push(...runs);
    }
  }
  const out = {};
  for (const [key, runs] of Object.entries(acc)) {
    const d = runs.map((r) => r.distanceM).sort((a, b) => a - b);
    const t = runs.map((r) => r.durationS).sort((a, b) => a - b);
    const mid = (arr) => (arr.length % 2 ? arr[arr.length >> 1] : (arr[(arr.length >> 1) - 1] + arr[arr.length >> 1]) / 2);
    out[key] = { distanceM: mid(d), durationS: mid(t), runs: runs.length };
  }
  fleetCache = { at: Date.now(), value: out };
  return out;
}

function invalidateFleetLegs() { fleetCache = { at: 0, value: null }; }

// ---------------------------------------------------------------------------
// Orders, declarations, reviews, processing results
// ---------------------------------------------------------------------------

async function ordersForRide(ride) {
  // Orders for the ride's calendar day. Both the driver's own and any order to
  // a customer they visited — the second kind is how a mis-assignment is found,
  // so restricting the query to assignedDriverId would hide the problem.
  const dayStart = Date.parse(`${ride.dayKey}T00:00:00+05:30`);
  const dayEnd = dayStart + 24 * 3600 * 1000;
  // An order may carry only a delivery window, or only a delivery time, with
  // no orderedAt at all. Reading by orderedAt alone never loaded those, so
  // they could never match a visit. Each time field is read and the results
  // merged.
  const from = dayStart - 12 * 3600 * 1000;
  const LIMIT = 5000;
  const snaps = await Promise.all(['orderedAt', 'windowStart', 'windowEnd', 'deliveredAt'].map((f) => C.orders()
    .where(f, '>=', from).where(f, '<', dayEnd).limit(LIMIT).get()));
  const byId = new Map();
  for (const snap of snaps) {
    if (snap.size >= LIMIT) console.warn(`ordersForRide: ${ride.dayKey} has ${LIMIT}+ orders on one field; some may be missing`);
    for (const d of snap.docs) byId.set(d.id, { id: d.id, ...d.data() });
  }
  return [...byId.values()];
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
  // The ride's result is now out of date, whether or not the recalculation
  // that follows gets to run straight away. See markInputsChanged.
  batch.update(C.rides().doc(rideId), { inputsChangedAt: Date.now() });
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
  await markInputsChanged(doc.data().rideId);
  await writeAudit({ adminId: reviewerId, action: 'segment.revert_review', target: reviewId, before: doc.data() });
  return { id: reviewId };
}

/* Something other than new points changed what a ride's result should be — an
 * office review, a revert, a driver's personal declaration. Recorded on the
 * ride so the next look recalculates it even if the immediate recalculation
 * could not run (another one held the ride) or failed. */
async function markInputsChanged(rideId) {
  if (!rideId) return;
  await C.rides().doc(rideId).update({ inputsChangedAt: Date.now() }).catch(() => {});
}

/* A per-ride lease, so two calculations of one ride never run at once.
 *
 * Rides are recalculated whenever the office looks, and two tabs refreshing
 * together would otherwise both load, compute and write — interleaving their
 * segment writes and deletes, and leaving totals from one run with segments
 * from the other. The lease lives on the ride document, so it holds across
 * Cloud Run instances, and it expires, so a crashed run cannot lock a ride.
 */
async function acquireCalcLease(rideId, holdMs = 2 * 60 * 1000) {
  const now = Date.now();
  const token = crypto.randomUUID();
  const got = await db.runTransaction(async (tx) => {
    const ref = C.rides().doc(rideId);
    const doc = await tx.get(ref);
    if (!doc.exists) return false;
    if ((doc.data().calcLeaseUntil || 0) > now) return false;
    tx.update(ref, { calcLeaseUntil: now + holdMs, calcLeaseToken: token });
    return true;
  });
  return got ? token : null;
}
async function releaseCalcLease(rideId, token) {
  await db.runTransaction(async (tx) => {
    const ref = C.rides().doc(rideId);
    const doc = await tx.get(ref);
    if (doc.exists && doc.data().calcLeaseToken === token) tx.update(ref, { calcLeaseUntil: 0, calcLeaseToken: null });
  });
}
// Recorded so a ride that fails every time is retried later rather than on
// every look, ahead of every ride that would succeed.
async function markCalcFailed(rideId, error) {
  await C.rides().doc(rideId).update({ calcFailedAt: Date.now(), calcError: String(error || '').slice(0, 300) }).catch(() => {});
}

// inputsAt is when this calculation read its points. A batch that lands after
// that is not in the result, and the ride must count as out of date; judging by
// the time the result was SAVED instead missed any batch uploaded while the
// calculation ran.
async function saveProcessing(rideId, result, { inputsAt = null } = {}) {
  const { segments, ...head } = result;
  await C.processing().doc(rideId).set({ ...head, processedAt: Date.now() }, { merge: false });
  // Segments live in a sub-collection: a ride can have hundreds, and Firestore
  // caps a document at 1 MiB.
  //
  // Segment ids are positional (seg_0000, seg_0001, …), so a recalculation
  // that finds fewer segments than last time would leave the old tail behind,
  // and the ride view would show segments from a result that no longer
  // exists. Rides are now recalculated repeatedly while they run, so that tail
  // is removed: anything not in the new result is deleted.
  const segIds = new Set(segments.map((seg) => seg.id));
  const oldSegs = await C.segments(rideId).select().get();
  const writer = db.bulkWriter();
  for (const seg of segments) writer.set(C.segments(rideId).doc(seg.id), seg, { merge: false });
  for (const d of oldSegs.docs) if (!segIds.has(d.id)) writer.delete(d.ref);
  await writer.close();
  await C.rides().doc(rideId).update({
    processedAt: Date.now(),
    processedInputsAt: inputsAt,
    calcVersion: result.calcVersion,
    calcFailedAt: null,
    calcError: null,
  });

  // Matches are queryable on their own for the matching report. The same rule
  // applies: a match the new result no longer makes must not survive in it.
  const matchId = (m) => `${rideId}_${m.segmentId}_${m.orderId}`;
  const keep = new Set(result.matching.matches.map(matchId));
  const oldMatches = await C.matches().where('rideId', '==', rideId).select().get();
  const mWriter = db.bulkWriter();
  for (const m of result.matching.matches) {
    mWriter.set(C.matches().doc(matchId(m)), { rideId, driverId: result.driverId, ...m }, { merge: false });
  }
  for (const d of oldMatches.docs) if (!keep.has(d.id)) mWriter.delete(d.ref);
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

// Paid road distances, reused (services/routeMatrix.js decides freshness).
const routeCache = {
  async getMany(keys) {
    if (!keys.length) return {};
    const snaps = await db.getAll(...keys.map((k) => C.routeCache().doc(k)));
    const out = {};
    for (const s of snaps) if (s.exists) out[s.id] = s.data();
    return out;
  },
  async putMany(entries) {
    const writer = db.bulkWriter();
    for (const [k, v] of Object.entries(entries)) {
      // expiresAt lets a Firestore TTL policy on route_cache clear old rows.
      writer.set(C.routeCache().doc(k), { ...v, expiresAt: new Date(v.cachedAt + 31 * 24 * 3600 * 1000) });
    }
    await writer.close();
  },
};

module.exports = {
  routeCache,
  getRounds, saveRound, deleteRound,
  getStopNames, addStopName, removeStopName,
  C, dayKeyFor, endOfDayMs, closeIfDayOver, acquireCalcLease, releaseCalcLease, markCalcFailed, markInputsChanged,
  getConfig, setConfigOverrides,
  writeAudit, writeEvent, openAlerts, applyAlertDiff, raiseAlertOnce,
  registerDriver, getDriver, listDrivers, updateDriver, nextDriverCode,
  startRide, stopRide, getRide, activeRides, listRides,
  ingestPoints, loadPoints,
  loadPlaces, invalidatePlaceCache,
  loadDriverLegs, recordDriverLegs, loadFleetLegs, invalidateFleetLegs,
  getLocationsLock, setLocationsLock,
  ordersForRide, declarationsForRide, reviewsForRide, addReview, revertReview,
  saveProcessing, loadProcessing,
  admin,
};
