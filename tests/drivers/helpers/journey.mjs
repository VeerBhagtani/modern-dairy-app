// Synthetic journey generator for the Modern Drivers test suite.
//
// This is TEST data and it is only ever used by tests. It is never loaded by
// the backend, never seeded into Firestore, and no code path treats its output
// as a real tracking record — hardcoded GPS masquerading as real tracking is
// exactly the failure mode this project cannot afford.
//
// It produces the same shape the Android app uploads: clientPointId, lat, lng,
// deviceTs, accuracyM, speedMps, provider.

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Deterministic PRNG (mulberry32) — a seeded generator means a failing test is
// reproducible, which a Math.random() fixture never is.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Real Pune coordinates, used so the distances in the assertions are the
// distances a Pune dispatcher would recognise.
export const PLACES = {
  DAIRY:        { id: 'fac_market_yard', name: 'Modern Dairy — Market Yard', lat: 18.5018, lng: 73.8636, radiusM: 150 },
  RESTAURANT_A: { id: 'res_a', name: 'Restaurant A (Swargate)',  customerId: 'CUST-A', lat: 18.5012, lng: 73.8586, radiusM: 80 },
  RESTAURANT_B: { id: 'res_b', name: 'Restaurant B (Deccan)',    customerId: 'CUST-B', lat: 18.5165, lng: 73.8410, radiusM: 80 },
  RESTAURANT_C: { id: 'res_c', name: 'Restaurant C (Hadapsar)',  customerId: 'CUST-C', lat: 18.5089, lng: 73.9260, radiusM: 80 },
  RESTAURANT_D: { id: 'res_d', name: 'Restaurant D (Kondhwa)',   customerId: 'CUST-D', lat: 18.4790, lng: 73.8890, radiusM: 80 },
  PERSONAL_1:   { id: 'p1', name: 'Porter customer 1', lat: 18.5310, lng: 73.8290 },
  PERSONAL_2:   { id: 'p2', name: 'Porter customer 2', lat: 18.5560, lng: 73.8070 },
  PERSONAL_3:   { id: 'p3', name: 'Porter customer 3', lat: 18.5700, lng: 73.7800 },
};

/**
 * Build a point track through a list of legs.
 * @param {Array} waypoints [{ at:{lat,lng}, dwellSec }]
 * @param {object} opts { startTs, intervalSec, speedMps, noiseM, seed, deviceId,
 *                        gapAfterWaypoint, gapSec, spikeAfterIndex }
 */
export function buildTrack(waypoints, opts = {}) {
  const {
    startTs = Date.parse('2026-09-15T03:30:00Z'), // 09:00 IST
    intervalSec = 30,
    speedMps = 9,            // ~32 km/h, honest for Pune traffic
    noiseM = 6,
    seed = 42,
    deviceId = 'dev-test',
    gapAfterWaypoint = null, // index of the waypoint after which GPS goes dark
    gapSec = 360,
    spikeAfterIndex = null,  // absolute point index after which to inject a teleport
  } = opts;

  const rand = rng(seed);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * noiseM / 1.5;
  const mPerDegLat = 111320;
  const mPerDegLng = (lat) => 111320 * Math.cos(toRad(lat));

  const points = [];
  let ts = startTs;
  let seq = 0;
  // Injected at the first travel point at or after this index — a dwell can sit
  // across the requested index, and a spike that silently never fired would
  // make the test assert nothing.
  let spikePending = spikeAfterIndex !== null;
  const push = (lat, lng, extra = {}) => {
    points.push({
      clientPointId: `${deviceId}:${String(seq).padStart(6, '0')}`,
      lat: lat + gauss() / mPerDegLat,
      lng: lng + gauss() / mPerDegLng(lat),
      deviceTs: ts,
      accuracyM: 8 + Math.round(rand() * 10),
      speedMps: extra.moving ? speedMps : 0,
      headingDeg: null,
      provider: 'fused',
      ...extra.raw,
    });
    seq += 1;
  };

  for (let w = 0; w < waypoints.length; w += 1) {
    const { at, dwellSec = 0 } = waypoints[w];

    // Dwell at the waypoint.
    for (let t = 0; t < dwellSec; t += intervalSec) {
      push(at.lat, at.lng, { moving: false });
      ts += intervalSec * 1000;
    }

    if (gapAfterWaypoint === w) {
      // GPS goes dark: the vehicle keeps moving but nothing is recorded. The
      // pipeline must call this a gap and estimate it, not measure it.
      ts += gapSec * 1000;
    }

    const next = waypoints[w + 1];
    if (!next) break;

    const legM = haversine(at, next.at);
    const steps = Math.max(1, Math.round(legM / (speedMps * intervalSec)));
    for (let s = 1; s <= steps; s += 1) {
      const f = s / steps;
      push(at.lat + (next.at.lat - at.lat) * f, at.lng + (next.at.lng - at.lng) * f, { moving: true });
      ts += intervalSec * 1000;
      if (spikePending && points.length >= spikeAfterIndex) {
        spikePending = false;
        // A 3 km teleport and back — the classic urban multipath spike. It must
        // be rejected as implausible, not added to anyone's kilometres.
        points.push({
          clientPointId: `${deviceId}:spike`,
          lat: at.lat + 0.027, lng: at.lng + 0.027,
          deviceTs: ts, accuracyM: 12, speedMps: 0, provider: 'fused',
        });
        ts += intervalSec * 1000;
      }
    }
  }

  return points;
}

// The journey from the brief:
// Dairy → A → B → personal 1 → 2 → 3 → Dairy → C → D → Dairy
export function fullDayJourney(opts = {}) {
  const P = PLACES;
  return buildTrack([
    { at: P.DAIRY,        dwellSec: 900 },  // loading
    { at: P.RESTAURANT_A, dwellSec: 480 },
    { at: P.RESTAURANT_B, dwellSec: 420 },
    { at: P.PERSONAL_1,   dwellSec: 300 },
    { at: P.PERSONAL_2,   dwellSec: 360 },
    { at: P.PERSONAL_3,   dwellSec: 300 },
    { at: P.DAIRY,        dwellSec: 600 },  // reload
    { at: P.RESTAURANT_C, dwellSec: 480 },
    { at: P.RESTAURANT_D, dwellSec: 420 },
    { at: P.DAIRY,        dwellSec: 300 },  // end of day
  ], opts);
}

export const FACILITIES = [PLACES.DAIRY];
export const RESTAURANTS = [PLACES.RESTAURANT_A, PLACES.RESTAURANT_B, PLACES.RESTAURANT_C, PLACES.RESTAURANT_D];
