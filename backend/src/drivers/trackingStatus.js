/* What is actually happening with a driver's tracking, in one word and one
 * sentence, from evidence the server holds.
 *
 * This replaces "no signal", which said the same thing for a phone with
 * location switched off, a phone in a dead zone holding fixes it cannot send,
 * a phone the battery saver killed, and a ride nobody has heard from. Each
 * has a different remedy and now a different name.
 *
 * Rules:
 *  - LIVE only on a recent FIX, by the server's clock (the phone's clock
 *    corrected, see deviceHealth.clockCorrection). An active ride is not
 *    evidence of anything; neither is a recent upload of old fixes.
 *  - The phone's own report decides between the other states only while it
 *    is recent. An old report is history, and is said to be.
 *  - INTERNET_DISCONNECTED is claimed only when the phone itself said so.
 *    When the server has simply heard nothing, that is STALE, and the
 *    sentence lists what it could be.
 *  - The dashboard's own connection to the server is not part of this: a
 *    browser losing its connection says nothing about the driver.
 * Pure.
 */
'use strict';

const STATE = {
  LIVE: 'LIVE',
  GPS_UNAVAILABLE: 'GPS_UNAVAILABLE',
  INTERNET_DISCONNECTED: 'INTERNET_DISCONNECTED',
  SYNC_PENDING: 'SYNC_PENDING',
  STALE: 'STALE',
  SERVICE_INTERRUPTED: 'SERVICE_INTERRUPTED',
  UNKNOWN: 'UNKNOWN',
  RIDE_STOPPED: 'RIDE_STOPPED',
  NOT_STARTED: 'NOT_STARTED',
};

const LABEL = {
  LIVE: 'Live',
  GPS_UNAVAILABLE: 'GPS unavailable',
  INTERNET_DISCONNECTED: 'Internet disconnected',
  SYNC_PENDING: 'Sync pending',
  STALE: 'Stale location',
  SERVICE_INTERRUPTED: 'Tracking interrupted',
  UNKNOWN: 'Unknown',
  RIDE_STOPPED: 'Ride stopped',
  NOT_STARTED: 'Not started',
};

// The phone takes a fix every second; it keeps one at least every 25-30 s.
// Two minutes without one, while the recorder says it is running, is GPS
// trouble (indoors, a basement, the OS throttling), not a parked driver.
const GPS_SILENT_MS = 120 * 1000;

const hm = (ms) => (ms == null ? '—' : new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16));
const mins = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m === 1 ? '1 min' : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
};

/**
 * @param ride  today's ride for the driver (active, or the latest stopped one), or null
 * @param live  the driver_live document, or null
 * @param nowMs server clock
 * @param cfg   { liveLocationSec, healthIntervalSec }
 * @returns { state, label, detail, since, lastLocation, device, evidence }
 */
function trackingStatus({ ride, live, nowMs, cfg }) {
  const liveMs = (cfg.liveLocationSec || 60) * 1000;
  const healthFreshMs = 2 * (cfg.healthIntervalSec || 60) * 1000 + 30000;

  // Only this ride's fix counts as its location; yesterday's position is
  // not where the driver is today.
  const sameRide = !!(live && ride && live.rideId === ride.id);
  const hasFix = !!(live && Number.isFinite(live.lat) && Number.isFinite(live.deviceTs));
  const fixAt = hasFix ? live.deviceTs : null;              // stored already corrected
  const lastLocation = hasFix ? {
    lat: live.lat, lng: live.lng, fixAt, receivedAt: live.serverTs || null,
    accuracyM: live.accuracyM ?? null, ageSec: Math.max(0, Math.round((nowMs - fixAt) / 1000)), thisRide: sameRide,
  } : null;
  const health = live && live.health && live.healthAt && (!ride || live.healthAt >= (ride.startedAt || 0) - 60000) ? live.health : null;
  const healthAge = health ? nowMs - live.healthAt : Infinity;
  const fresh = healthAge <= healthFreshMs;
  const device = health ? { ...health, reportedAt: live.healthAt, reportAgeSec: Math.round(healthAge / 1000), fresh } : null;
  const out = (state, detail, since = null) => ({ state, label: LABEL[state], detail, since, lastLocation, device });

  if (!ride) return out(STATE.NOT_STARTED, 'No ride today.');
  if (ride.status !== 'active') {
    const by = ride.stopKind === 'day_end' ? 'closed at the end of the day' : ride.stoppedByName ? `stopped by ${ride.stoppedByName}` : 'stopped by the office';
    return out(STATE.RIDE_STOPPED, `Ride ${by} at ${hm(ride.stoppedAt)}.`, ride.stoppedAt || null);
  }

  const fixAge = sameRide && hasFix ? nowMs - fixAt : Infinity;
  if (fixAge <= liveMs) {
    const pending = device && fresh && device.queuedPoints > 0 ? ` ${device.queuedPoints} older fix(es) still uploading.` : '';
    return out(STATE.LIVE, `Fix ${Math.round(fixAge / 1000)} s old${lastLocation.accuracyM != null ? `, ±${Math.round(lastLocation.accuracyM)} m` : ''}.${pending}`, fixAt);
  }
  const lastSeen = sameRide && hasFix ? `Last fix ${hm(fixAt)} (${mins(fixAge)} ago).` : 'No fix has reached the office yet.';

  if (device && fresh) {
    if (device.gpsEnabled === false) return out(STATE.GPS_UNAVAILABLE, `The phone's Location switch is off. ${lastSeen}`, live.healthAt);
    if (device.locationPermission === 'denied') return out(STATE.GPS_UNAVAILABLE, `Location permission is refused for the app. ${lastSeen}`, live.healthAt);
    if (device.authError) return out(STATE.SERVICE_INTERRUPTED, `The app is signed out (${device.authError}); fixes cannot be sent. ${lastSeen}`, live.healthAt);
    if (device.watcherRunning === false) return out(STATE.SERVICE_INTERRUPTED, `The app is open but its location recorder is not running. ${lastSeen}`, live.healthAt);
    if (device.lastFixAt && live.healthAt - device.lastFixAt > GPS_SILENT_MS) {
      return out(STATE.GPS_UNAVAILABLE, `The phone has had no GPS fix since ${hm(device.lastFixAt)} (indoors, or GPS blocked). ${lastSeen}`, device.lastFixAt);
    }
    if (device.queuedPoints > 0) {
      return out(STATE.SYNC_PENDING, `${device.queuedPoints} fix(es) recorded on the phone, not yet received${device.oldestQueuedAt ? `, oldest ${hm(device.oldestQueuedAt)}` : ''}${device.lastUploadError ? `; last upload error: ${device.lastUploadError}` : ''}.`, device.oldestQueuedAt || null);
    }
    if (device.online === false) return out(STATE.INTERNET_DISCONNECTED, `The phone reports no internet connection. ${lastSeen}`, live.healthAt);
    return out(STATE.STALE, `The phone reports normally (${hm(live.healthAt)}) but sent no new fix. ${lastSeen}`, fixAt);
  }

  // Nothing recent from the phone at all.
  if (device && device.online === false) {
    return out(STATE.INTERNET_DISCONNECTED, `The phone last reported no internet at ${hm(live.healthAt)}. ${lastSeen}`, live.healthAt);
  }
  if (sameRide && hasFix) {
    return out(STATE.STALE, `Nothing from the phone since ${hm(Math.max(fixAt, live.healthAt || 0))}: no internet, the phone switched off, or the app closed by the phone. ${lastSeen}`, fixAt);
  }
  return out(STATE.UNKNOWN, `Ride started ${hm(ride.startedAt)}; no fix and no report from the phone yet.`, ride.startedAt || null);
}

// For the map marker: green only when LIVE; a last-known position otherwise.
function locationState(status) {
  if (status.state === STATE.LIVE) return 'live';
  return status.lastLocation ? 'stale' : 'unavailable';
}

module.exports = { trackingStatus, locationState, STATE, LABEL, GPS_SILENT_MS };
