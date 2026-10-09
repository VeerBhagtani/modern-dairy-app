/* What a phone tells the server about itself, and the phone's clock.
 *
 * Two things the server cannot see on its own:
 *
 * 1. The phone's state: whether location is allowed and switched on, whether
 *    the recorder is running, how many fixes are still waiting on the phone,
 *    when the last upload worked and why the last one failed. The app sends
 *    this with every upload and, when it has nothing to upload, on its own
 *    (POST /driver/health). It is the phone's word, kept apart from what the
 *    server observed, and every field may be missing on an older APK.
 *
 * 2. The phone's clock. Points carry the phone's time. A phone set by hand
 *    ten minutes slow had every fix refused as "recorded before this ride
 *    started" (the ride start is server time) — and the app deletes refused
 *    fixes, so the day was lost. A phone running fast past the skew limit had
 *    every fix refused as "in the future". Each upload now carries the
 *    phone's own time of sending; the difference from the server's clock is
 *    the phone's error, and it is taken off every fix in that upload.
 *    Network delay is seconds, so only an error of a minute or more is
 *    corrected. Pure.
 */
'use strict';

const CLOCK_CORRECT_MIN_MS = 60 * 1000;
// Past this the "phone time" is not a clock that is off, it is garbage.
const CLOCK_CORRECT_MAX_MS = 7 * 864e5;

/* @returns ms to ADD to the phone's timestamps (0 when the phone is right). */
function clockCorrection(sentAt, nowMs) {
  const s = Number(sentAt);
  if (!Number.isFinite(s) || s <= 0) return 0;
  const skew = nowMs - s;
  if (Math.abs(skew) < CLOCK_CORRECT_MIN_MS || Math.abs(skew) > CLOCK_CORRECT_MAX_MS) return 0;
  return Math.round(skew);
}

const str = (v, n = 32) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);
const ts = (v, correction) => (Number.isFinite(v) && v > 0 ? Math.round(v + correction) : null);

/* The report, whitelisted and bounded. Times are moved onto the server's
 * clock with the same correction as the points. */
function sanitizeHealth(b, { correction = 0 } = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  return {
    locationPermission: str(b.locationPermission),
    backgroundPermission: str(b.backgroundPermission),
    gpsEnabled: bool(b.gpsEnabled),
    batteryOptimised: bool(b.batteryOptimised),
    online: bool(b.online),
    watcherRunning: bool(b.watcherRunning),
    queuedPoints: num(b.queuedPoints),
    oldestQueuedAt: ts(b.oldestQueuedAt, correction),
    lastFixAt: ts(b.lastFixAt, correction),
    lastFixAccuracyM: num(b.lastFixAccuracyM),
    lastUploadOkAt: ts(b.lastUploadOkAt, correction),
    lastUploadError: str(b.lastUploadError, 160),
    uploadFailures: num(b.uploadFailures),
    pointsRecorded: num(b.pointsRecorded),
    authError: str(b.authError, 160),
    appVersion: str(b.appVersion),
    batteryPct: num(b.batteryPct),
  };
}

// The fields whose change is worth an event row. Counters and times change on
// every report and would write a row a minute per driver for nothing.
const STATE_FIELDS = ['locationPermission', 'backgroundPermission', 'gpsEnabled', 'batteryOptimised', 'online', 'watcherRunning', 'authError', 'appVersion'];
function healthChanged(prev, next) {
  if (!next) return false;
  if (!prev) return true;
  return STATE_FIELDS.some((k) => (prev[k] ?? null) !== (next[k] ?? null));
}

module.exports = { clockCorrection, sanitizeHealth, healthChanged, CLOCK_CORRECT_MIN_MS };
