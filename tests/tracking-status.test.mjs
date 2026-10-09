// The office's tracking states, one rule at a time. Each case is a situation
// a real phone gets into; the state must name it, and must never be LIVE on
// anything but a recent fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const { trackingStatus, locationState } = require('./src/drivers/trackingStatus');
const { clockCorrection, sanitizeHealth, healthChanged } = require('./src/drivers/deviceHealth');

const NOW = Date.parse('2026-10-09T10:00:00+05:30');
const cfg = { liveLocationSec: 60, healthIntervalSec: 60 };
const ride = { id: 'r1', status: 'active', startedAt: NOW - 3 * 3600e3 };
const fix = (ageSec, extra = {}) => ({ rideId: 'r1', lat: 18.5, lng: 73.8, deviceTs: NOW - ageSec * 1000, serverTs: NOW - ageSec * 1000 + 2000, accuracyM: 8, ...extra });
const st = (live, r = ride) => trackingStatus({ ride: r, live, nowMs: NOW, cfg });
const healthy = { locationPermission: 'granted', gpsEnabled: true, watcherRunning: true, online: true, queuedPoints: 0, lastFixAt: NOW - 5000 };

test('LIVE only on a fix under the threshold', () => {
  assert.equal(st(fix(20)).state, 'LIVE');
  assert.equal(st(fix(61)).state, 'STALE');
  assert.equal(locationState(st(fix(20))), 'live');
  assert.equal(locationState(st(fix(600))), 'stale', 'last known position, not live');
});

test('an active ride with nothing heard is UNKNOWN, never LIVE', () => {
  assert.equal(st(null).state, 'UNKNOWN');
  assert.equal(st(fix(10, { rideId: 'yesterday' })).state, 'UNKNOWN', 'yesterday\'s position is not today\'s');
});

test('the phone\'s own recent report names the cause', () => {
  const at = (h, ageSec = 10) => ({ ...fix(400), health: { ...healthy, ...h }, healthAt: NOW - ageSec * 1000 });
  assert.equal(st(at({ gpsEnabled: false })).state, 'GPS_UNAVAILABLE');
  assert.equal(st(at({ locationPermission: 'denied' })).state, 'GPS_UNAVAILABLE');
  assert.equal(st(at({ lastFixAt: NOW - 5 * 60000 })).state, 'GPS_UNAVAILABLE', 'no fix on the phone for minutes');
  assert.equal(st(at({ watcherRunning: false })).state, 'SERVICE_INTERRUPTED');
  assert.equal(st(at({ authError: 'Signed out' })).state, 'SERVICE_INTERRUPTED');
  assert.equal(st(at({ queuedPoints: 40, oldestQueuedAt: NOW - 600000 })).state, 'SYNC_PENDING');
  assert.equal(st(at({ online: false })).state, 'INTERNET_DISCONNECTED');
  assert.equal(st(at({})).state, 'STALE');
});

test('internet is blamed only when the phone said so; silence is STALE', () => {
  assert.equal(st(fix(900)).state, 'STALE');
  assert.match(st(fix(900)).detail, /no internet, the phone switched off, or the app closed/);
  const said = { ...fix(900), health: { ...healthy, online: false }, healthAt: NOW - 20 * 60000 };
  assert.equal(st(said).state, 'INTERNET_DISCONNECTED');
  assert.match(st(said).detail, /last reported/);
});

test('an old report is not trusted as current', () => {
  const old = { ...fix(900), health: { ...healthy, gpsEnabled: false }, healthAt: NOW - 30 * 60000 };
  assert.equal(st(old).state, 'STALE');
  assert.equal(st(old).device.fresh, false);
});

test('ride stopped and no ride', () => {
  assert.equal(st(fix(5), { ...ride, status: 'stopped', stoppedAt: NOW - 60000 }).state, 'RIDE_STOPPED');
  assert.equal(st(fix(5), null).state, 'NOT_STARTED');
  assert.ok(st(fix(5), { ...ride, status: 'stopped', stoppedAt: NOW }).lastLocation, 'the last position is still given');
});

test('phone clock correction: a minute or more, never a crazy value', () => {
  assert.equal(clockCorrection(NOW - 10 * 60000, NOW), 10 * 60000);
  assert.equal(clockCorrection(NOW + 45 * 60000, NOW), -45 * 60000);
  assert.equal(clockCorrection(NOW - 3000, NOW), 0, 'network delay is not a clock error');
  assert.equal(clockCorrection(undefined, NOW), 0, 'older apps send nothing');
  assert.equal(clockCorrection(1000, NOW), 0, 'nonsense is ignored');
});

test('the phone\'s report is whitelisted, bounded and moved onto the server clock', () => {
  const h = sanitizeHealth({ gpsEnabled: true, queuedPoints: 3, lastFixAt: NOW - 600000, token: 'secret', lastUploadError: 'x'.repeat(500) }, { correction: 600000 });
  assert.equal(h.lastFixAt, NOW);
  assert.equal(h.token, undefined);
  assert.equal(h.lastUploadError.length, 160);
  assert.equal(sanitizeHealth('nope'), null);
  assert.equal(healthChanged(h, { ...h, queuedPoints: 99 }), false, 'counters alone are not an event');
  assert.equal(healthChanged(h, { ...h, gpsEnabled: false }), true);
});
