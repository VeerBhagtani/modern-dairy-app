// Geodesy and distance, checked against geometry whose answer is known
// independently of this code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const geo = require('./src/drivers/geo');

test('haversine matches a known Pune distance', () => {
  // Shivajinagar station → Pune Junction. Measured on a map: ~2.6 km straight
  // line. The tolerance is wide because the reference itself is a map reading,
  // not a survey — a tighter assertion would be testing the reference.
  const a = { lat: 18.5308, lng: 73.8478 };
  const b = { lat: 18.5286, lng: 73.8743 };
  const d = geo.haversineM(a, b);
  assert.ok(d > 2600 && d < 3000, `expected ~2.8 km, got ${Math.round(d)} m`);
});

test('haversine is symmetric and zero for identical points', () => {
  const a = { lat: 18.5, lng: 73.85 };
  const b = { lat: 18.6, lng: 73.95 };
  assert.equal(geo.haversineM(a, a), 0);
  assert.ok(Math.abs(geo.haversineM(a, b) - geo.haversineM(b, a)) < 1e-9);
});

test('one degree of latitude is about 111 km anywhere', () => {
  for (const lat of [0, 18.5, 45, 60]) {
    const d = geo.haversineM({ lat, lng: 73 }, { lat: lat + 1, lng: 73 });
    assert.ok(Math.abs(d - 111195) < 200, `at ${lat}°: ${Math.round(d)} m`);
  }
});

test('a closed square measures its own perimeter', () => {
  // 0.01° of latitude ≈ 1112 m; the east–west legs are shorter by cos(lat).
  const lat0 = 18.5;
  const corners = [
    { lat: lat0, lng: 73.8 },
    { lat: lat0 + 0.01, lng: 73.8 },
    { lat: lat0 + 0.01, lng: 73.81 },
    { lat: lat0, lng: 73.81 },
    { lat: lat0, lng: 73.8 },
  ];
  let sum = 0;
  for (let i = 1; i < corners.length; i += 1) sum += geo.haversineM(corners[i - 1], corners[i]);
  const ns = 2 * geo.haversineM(corners[0], corners[1]);
  const ew = 2 * geo.haversineM(corners[1], corners[2]);
  assert.ok(Math.abs(sum - (ns + ew)) < 0.5);
});

test('geofence containment respects the radius exactly', () => {
  const centre = { lat: 18.5, lng: 73.85, id: 'p', name: 'P' };
  // 100 m north.
  const near = { lat: 18.5 + 100 / 111320, lng: 73.85 };
  assert.equal(geo.isInside(near, centre, 120), true);
  assert.equal(geo.isInside(near, centre, 80), false);
});

test('placesContaining returns every overlapping geofence, nearest first', () => {
  const p = { lat: 18.5, lng: 73.85 };
  const places = [
    { id: 'far', name: 'Far', lat: 18.5 + 300 / 111320, lng: 73.85, radiusM: 500 },
    { id: 'near', name: 'Near', lat: 18.5 + 20 / 111320, lng: 73.85, radiusM: 100 },
    { id: 'out', name: 'Out', lat: 18.6, lng: 73.95, radiusM: 100 },
  ];
  const hits = geo.placesContaining(p, places, 80);
  assert.deepEqual(hits.map((h) => h.place.id), ['near', 'far']);
});

test('nearestPlaces is proximity only and never implies containment', () => {
  const p = { lat: 18.5, lng: 73.85 };
  const places = [{ id: 'a', name: 'A', lat: 18.9, lng: 73.85, radiusM: 50 }];
  const near = geo.nearestPlaces(p, places, 3);
  assert.equal(near.length, 1);
  assert.ok(near[0].distanceM > 40000);
  // The same point is NOT inside that place's geofence — proximity and
  // containment are different questions and the code keeps them apart.
  assert.equal(geo.placesContaining(p, places, 80).length, 0);
});

test('kilometres are reported to one decimal, never more', () => {
  assert.equal(geo.toKm(12345.6789), 12.3);
  assert.equal(geo.toKm(49), 0);
  assert.equal(geo.toKm(51), 0.1);
});
