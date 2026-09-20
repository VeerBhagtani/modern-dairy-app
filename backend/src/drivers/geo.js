// Geodesy. Deliberately dependency-free: these few functions decide what the
// company pays its drivers for, so they must be readable, testable and
// reproducible forever. A library here would be a liability, not a saving.

// WGS-84 mean radius. Over the 10–500 m hops this system measures, haversine
// on a sphere differs from Vincenty on the ellipsoid by well under half a
// metre — far below GPS noise, so the extra maths would be false precision.
const EARTH_RADIUS_M = 6371008.8;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Great-circle distance in metres between two {lat,lng} points.
function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing a→b in degrees (0–360). Used for anomaly reporting only.
function bearingDeg(a, b) {
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Arithmetic mean of a point list. Correct enough for a stop cluster spanning
// tens of metres; a spherical centroid would move the answer by microns.
function centroid(points) {
  if (!points.length) return null;
  let lat = 0, lng = 0;
  for (const p of points) { lat += p.lat; lng += p.lng; }
  return { lat: lat / points.length, lng: lng / points.length };
}

// Cheap bounding-box rejection before the trig. At ~10² places checked per
// stop this is not about speed; it is about not doing 10² sqrt calls per stop
// when the place list grows.
function withinBox(a, b, radiusM) {
  const dLat = Math.abs(a.lat - b.lat) * 111320;
  if (dLat > radiusM) return false;
  const mPerDegLng = 111320 * Math.cos(toRad(a.lat));
  // Near the poles mPerDegLng → 0 and the box degenerates; Pune is at 18°N so
  // this is defensive only.
  const dLng = Math.abs(a.lng - b.lng) * Math.max(mPerDegLng, 1);
  return dLng <= radiusM;
}

// Is `point` inside the circle of `radiusM` around `place`?
function isInside(point, place, radiusM) {
  if (!withinBox(point, place, radiusM)) return false;
  return haversineM(point, place) <= radiusM;
}

// Every active place whose geofence contains the point, nearest first.
// Returns [{ place, distanceM, radiusM }]. More than one hit is a real and
// common situation (a mall, a market lane) and the caller must treat it as
// ambiguity rather than picking the first one blindly.
function placesContaining(point, places, defaultRadiusM) {
  const hits = [];
  for (const place of places) {
    const radiusM = Number.isFinite(place.radiusM) && place.radiusM > 0 ? place.radiusM : defaultRadiusM;
    if (!withinBox(point, place, radiusM)) continue;
    const distanceM = haversineM(point, place);
    if (distanceM <= radiusM) hits.push({ place, distanceM, radiusM });
  }
  hits.sort((x, y) => x.distanceM - y.distanceM);
  return hits;
}

// Nearest place regardless of geofence — for "what was near this stop?" in the
// review UI. NEVER used to classify: being near a restaurant is not evidence
// of visiting it.
function nearestPlaces(point, places, limit = 3) {
  return places
    .map((place) => ({ place, distanceM: haversineM(point, place) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

// Metres → kilometres at one decimal. One decimal is the honest resolution of
// a GPS-derived distance; reporting metres would be false precision.
function toKm(metres) {
  return Math.round((metres / 1000) * 10) / 10;
}

module.exports = {
  EARTH_RADIUS_M, haversineM, bearingDeg, centroid,
  isInside, withinBox, placesContaining, nearestPlaces, toKm,
};
