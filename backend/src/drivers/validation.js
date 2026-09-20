// GPS point validation — used twice, for two different purposes:
//
//  1. INGEST (normaliseIncomingPoint): is this a well-formed point we are
//     willing to store at all? Garbage never reaches the database.
//  2. PROCESSING (classifyPointQuality): is a stored point trustworthy enough
//     to contribute DISTANCE? A point can fail this and still be kept — we
//     never delete raw data, we mark it and explain why.
//
// The two are separate on purpose. A 300-metre-accuracy fix is real evidence
// that the driver's phone was roughly somewhere; it is just not evidence of
// how far they drove.

const { haversineM } = require('./geo');

const MIN_PLAUSIBLE_TS = Date.parse('2020-01-01T00:00:00Z');

// Reasons a point is excluded from distance. Stored on the point so the
// replay map and the reliability report can show exactly what was dropped.
const QUALITY = {
  OK: 'ok',
  BAD_COORDS: 'bad_coords',
  BAD_TIMESTAMP: 'bad_timestamp',
  BAD_ACCURACY: 'bad_accuracy',
  LOW_ACCURACY: 'low_accuracy',      // kept, counted, but flagged in the health report
  IMPLAUSIBLE_JUMP: 'implausible_jump',
  MOCK_LOCATION: 'mock_location',
  DUPLICATE: 'duplicate',
};

function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// ---------------------------------------------------------------------------
// 1. Ingest
// ---------------------------------------------------------------------------

// Turns one item of an upload batch into the exact document we store, or
// returns { error } explaining the refusal. Nothing else is persisted: a
// client cannot introduce a field by sending it.
//
// `clientPointId` is the de-duplication key and becomes the document id, so it
// must be a Firestore-safe, bounded string. The app builds it as
// `<deviceId>:<monotonic seq>`, which makes a replayed batch idempotent.
function normaliseIncomingPoint(raw, { nowMs, clockSkewMin }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'point must be an object' };

  const id = raw.clientPointId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_:.-]{1,128}$/.test(id)) {
    return { error: 'clientPointId must be a safe id of 1..128 chars' };
  }
  if (!isFiniteNum(raw.lat) || raw.lat < -90 || raw.lat > 90) return { error: 'lat out of range' };
  if (!isFiniteNum(raw.lng) || raw.lng < -180 || raw.lng > 180) return { error: 'lng out of range' };
  // (0,0) in the Gulf of Guinea is what a failed fix looks like, not a place
  // any Pune driver has ever been.
  if (raw.lat === 0 && raw.lng === 0) return { error: 'null island coordinates' };

  const deviceTs = isFiniteNum(raw.deviceTs) ? raw.deviceTs : Date.parse(raw.deviceTs);
  if (!Number.isFinite(deviceTs) || deviceTs < MIN_PLAUSIBLE_TS) return { error: 'deviceTs is missing or implausible' };
  if (deviceTs > nowMs + clockSkewMin * 60000) return { error: 'deviceTs is in the future beyond the allowed clock skew' };

  const accuracyM = isFiniteNum(raw.accuracyM) ? raw.accuracyM : null;
  if (accuracyM !== null && (accuracyM < 0 || accuracyM > 100000)) return { error: 'accuracyM out of range' };

  return {
    point: {
      clientPointId: id,
      lat: raw.lat,
      lng: raw.lng,
      deviceTs,
      accuracyM,
      // Optional telemetry. Absent is a normal, honest answer — Android does
      // not always supply speed or heading, and guessing would be worse.
      speedMps: isFiniteNum(raw.speedMps) && raw.speedMps >= 0 && raw.speedMps < 200 ? raw.speedMps : null,
      headingDeg: isFiniteNum(raw.headingDeg) && raw.headingDeg >= 0 && raw.headingDeg <= 360 ? raw.headingDeg : null,
      altitudeM: isFiniteNum(raw.altitudeM) ? raw.altitudeM : null,
      provider: typeof raw.provider === 'string' ? raw.provider.slice(0, 32) : null,
      batteryPct: isFiniteNum(raw.batteryPct) && raw.batteryPct >= 0 && raw.batteryPct <= 100 ? raw.batteryPct : null,
      isMoving: typeof raw.isMoving === 'boolean' ? raw.isMoving : null,
      // Android exposes this; it is the only mock-location signal available
      // from user space and a rooted device can still lie about it.
      mock: raw.mock === true,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Processing
// ---------------------------------------------------------------------------

// Verdict for one stored point, given the previous point that was ACCEPTED
// (not merely the previous point in the list — otherwise one teleport spike
// would drag the whole rest of the track out of plausibility with it).
function classifyPointQuality(point, prevAccepted, cfg, nowMs) {
  if (!isFiniteNum(point.lat) || !isFiniteNum(point.lng)
      || point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180
      || (point.lat === 0 && point.lng === 0)) {
    return { quality: QUALITY.BAD_COORDS, countDistance: false };
  }
  if (!isFiniteNum(point.deviceTs) || point.deviceTs < MIN_PLAUSIBLE_TS
      || point.deviceTs > nowMs + cfg.clockSkewMin * 60000) {
    return { quality: QUALITY.BAD_TIMESTAMP, countDistance: false };
  }
  if (point.mock === true) {
    return { quality: QUALITY.MOCK_LOCATION, countDistance: false };
  }
  if (isFiniteNum(point.accuracyM) && (point.accuracyM < 0 || point.accuracyM > cfg.rejectAccuracyM)) {
    return { quality: QUALITY.BAD_ACCURACY, countDistance: false };
  }
  if (prevAccepted) {
    const dtSec = (point.deviceTs - prevAccepted.deviceTs) / 1000;
    if (dtSec < 0) return { quality: QUALITY.BAD_TIMESTAMP, countDistance: false };
    if (dtSec === 0) {
      const same = point.lat === prevAccepted.lat && point.lng === prevAccepted.lng;
      if (same) return { quality: QUALITY.DUPLICATE, countDistance: false };
      // Two different positions at the same instant: one of them is wrong and
      // we cannot tell which, so the later one does not get to add distance.
      return { quality: QUALITY.IMPLAUSIBLE_JUMP, countDistance: false, detail: 'two positions at one timestamp' };
    }
    const distM = haversineM(prevAccepted, point);
    const speed = distM / dtSec;
    // Only judge speed over short intervals. After a long silence the phone
    // legitimately reappears far away; that is a GAP (handled in track.js),
    // not a teleport, and calling it a teleport would delete a real journey.
    if (dtSec <= cfg.gapSeconds && speed > cfg.maxSpeedMps) {
      return {
        quality: QUALITY.IMPLAUSIBLE_JUMP,
        countDistance: false,
        detail: `${Math.round(distM)} m in ${Math.round(dtSec)} s = ${speed.toFixed(1)} m/s`,
      };
    }
  }
  if (isFiniteNum(point.accuracyM) && point.accuracyM > cfg.warnAccuracyM) {
    // Counted, but the reliability report needs to know the day was noisy.
    return { quality: QUALITY.LOW_ACCURACY, countDistance: true };
  }
  return { quality: QUALITY.OK, countDistance: true };
}

module.exports = { QUALITY, normaliseIncomingPoint, classifyPointQuality, MIN_PLAUSIBLE_TS };
