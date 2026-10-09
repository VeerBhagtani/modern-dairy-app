// The driver app's upload pipeline, run for real against a fake server:
// every fix is queued on the phone first, uploaded on a clock (not after ten
// fixes), retried with back-off when the network is gone, kept when the
// server refuses for a reason that can change, and dropped only when the
// server says no server ever will take it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { makeIndexedDB } = require('./helpers/fake-idb.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'app/www/app.js'), 'utf8');
const realInterval = globalThis.setInterval;
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await tick(); };

function fakeDom() {
  const elements = new Map();
  const make = (id) => {
    const el = {
      id, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', className: '', handlers: {},
      style: { setProperty() {} }, classList: { add() {}, remove() {}, contains: () => false },
      addEventListener(k, fn) { (this.handlers[k] = this.handlers[k] || []).push(fn); }, removeEventListener() {},
      appendChild() {}, remove() {}, setAttribute() {}, focus() {}, querySelectorAll: () => [],
      click() { (this.handlers.click || []).forEach((fn) => fn({ target: el })); },
    };
    return el;
  };
  const get = (id) => { if (!elements.has(id)) elements.set(id, make(id)); return elements.get(id); };
  return {
    get,
    document: {
      documentElement: { style: { setProperty() {} } }, hidden: false,
      getElementById: get, querySelectorAll: () => [], createElement: () => make('created'),
      listeners: {}, addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
      body: { appendChild() {}, removeChild() {} },
    },
  };
}

function fakePhone() {
  const seen = { added: [], removed: [] };
  let cb = null; let n = 0;
  const bg = {
    addWatcher(o, f) { cb = f; seen.added.push(o); return Promise.resolve('w' + (++n)); },
    removeWatcher({ id }) { seen.removed.push(id); return Promise.resolve(); },
  };
  const geo = {
    checkPermissions: () => Promise.resolve({ location: 'granted' }),
    requestPermissions: () => Promise.resolve({ location: 'granted' }),
    getCurrentPosition: () => Promise.resolve({ coords: { latitude: 18.5, longitude: 73.86, accuracy: 8 } }),
  };
  return {
    seen,
    fix: (i, t) => cb({ latitude: 18.5, longitude: 73.86 + i * 0.0003, accuracy: 7, time: t, speed: 8, bearing: 90 }),
    capacitor: { registerPlugin: (name) => (name === 'BackgroundGeolocation' ? bg : name === 'Geolocation' ? geo : {}), Plugins: {} },
  };
}

/* A server that answers like the real one, and can be told to fail. */
function fakeServer() {
  const s = { uploads: [], health: [], mode: 'ok', stored: new Map(), rideActive: true };
  s.fetch = async (url, opts = {}) => {
    const p = url.replace('https://api.test', '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (s.mode === 'offline') throw new TypeError('Failed to fetch');
    if (p === '/driver/register') return reply(200, { success: true, data: { accessToken: 'a', refreshToken: 'r', driver: { id: 'd1', name: 'Ravi', driverCode: 'MD-1' }, tracking: { sampleIntervalSec: 30, maxBatchPoints: 200, uploadIntervalSec: 15, healthIntervalSec: 60 } } });
    if (p === '/driver/rides/active') return reply(200, { success: true, data: s.rideActive && s.started ? { active: true, rideId: 'ride1', startedAt: 1 } : { active: false, reason: 'End of shift', kind: 'admin' } });
    if (p === '/driver/rides/start') { s.started = true; return reply(200, { success: true, data: { rideId: 'ride1', startedAt: Date.now() } }); }
    if (p === '/driver/health') { s.health.push(body); return reply(200, { success: true, data: {} }); }
    if (p.startsWith('/driver/rides/ride1/points')) {
      s.uploads.push(body);
      if (s.mode === 'inactive') return reply(403, { success: false, code: 'ACCOUNT_INACTIVE', message: 'deactivated' });
      if (s.mode === 'notyours') return reply(403, { success: false, code: 'NOT_YOUR_RIDE', message: 'not yours' });
      if (s.mode === '500') return reply(503, { success: false, code: 'STORE_FAILED', message: 'retry' });
      const accepted = [];
      for (const pt of body.points) { if (!s.stored.has(pt.clientPointId)) s.stored.set(pt.clientPointId, pt); accepted.push(pt.clientPointId); }
      return reply(200, { success: true, data: { accepted, rejected: [], rideActive: s.rideActive } });
    }
    return reply(200, { success: true, data: {} });
  };
  return s;
}

async function launch({ server = fakeServer(), store = new Map() } = {}) {
  const dom = fakeDom();
  const phone = fakePhone();
  const winListeners = {};
  const win = {
    APP_CONFIG: { API_BASE: 'https://api.test', WATCHER_RETRY_MS: 5 },
    BRANDING: {}, Capacitor: phone.capacitor,
    addEventListener(k, fn) { (winListeners[k] = winListeners[k] || []).push(fn); },
  };
  const nav = { onLine: true, geolocation: null, userAgent: 'test' };
  const globals = {
    window: win, document: dom.document, navigator: nav, fetch: server.fetch,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    indexedDB: makeIndexedDB(),
  };
  const previous = {};
  for (const [k, v] of Object.entries(globals)) {
    previous[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  const timers = [];
  globalThis.setInterval = (fn, ms) => { const t = realInterval(fn, ms); t.unref?.(); timers.push(t); return t; };
  try { (0, eval)(SOURCE); } finally { globalThis.setInterval = realInterval; }   // eslint-disable-line no-eval
  dom.get('inName').value = 'Ravi';
  dom.get('btnName').click();
  await settle();
  dom.get('btnStart').click();
  await settle();
  return {
    server, phone, store, nav, state: win.ModernDrivers.state,
    fire: async (k) => { (winListeners[k] || []).forEach((fn) => fn()); await settle(); },
    resume: async () => { (dom.document.listeners.visibilitychange || []).forEach((fn) => fn()); await settle(); },
    stop() {
      timers.forEach(clearInterval);
      for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    },
  };
}

test('a fix reaches the office within the upload interval, not after ten fixes, with the phone\'s time and state', async () => {
  const t = await launch();
  try {
    assert.equal(t.state.rideId, 'ride1');
    const now = Date.now();
    t.phone.fix(0, now);
    await settle();
    assert.equal(t.server.uploads.length, 1, 'the first fix is sent at once');
    const up = t.server.uploads[0];
    assert.equal(up.points.length, 1);
    assert.equal(up.points[0].deviceTs, now, 'the fix keeps the time it was taken');
    assert.ok(Math.abs(up.sentAt - Date.now()) < 5000, 'the phone says what time it thinks it is');
    assert.equal(up.health.locationPermission, 'granted');
    assert.equal(up.health.watcherRunning, true);
    assert.equal(t.state.queued, 0, 'deleted from the phone once the server confirmed it');
  } finally { t.stop(); }
});

test('B: offline, fixes stay on the phone; the error is named; back-off; network back sends them all once', async () => {
  const t = await launch();
  try {
    t.server.mode = 'offline';
    const t0 = Date.now() - 60000;
    for (let i = 0; i < 30; i += 1) { t.state.lastSyncAttemptAt = 0; t.state.nextSyncAt = 0; t.phone.fix(i, t0 + i * 2000); await settle(8); }
    await settle();
    assert.equal(t.state.queued, 30, 'every fix is kept on the phone');
    assert.match(t.state.lastUploadError, /no connection/);
    assert.ok(t.state.uploadFailures >= 1);
    assert.ok(t.state.nextSyncAt > Date.now(), 'waits before trying again');
    assert.ok(t.state.oldestQueuedAt === t0, 'knows how old the oldest waiting fix is');
    // Network back.
    t.server.mode = 'ok';
    await t.fire('online');
    await settle(80);
    assert.equal(t.state.queued, 0);
    assert.equal(t.server.stored.size, 30);
    for (let i = 0; i < 30; i += 1) assert.equal(t.server.stored.get([...t.server.stored.keys()][i]).deviceTs, t0 + i * 2000);
    assert.equal(t.state.lastUploadError, null);
    assert.equal(t.state.uploadFailures, 0);
  } finally { t.stop(); }
});

test('a refusal that can change (account inactive, server error) keeps the queue; only "not your ride" drops it', async () => {
  const t = await launch();
  try {
    let i = 0;
    for (const mode of ['inactive', '500']) {
      t.server.mode = mode;
      t.state.lastSyncAttemptAt = 0; t.state.nextSyncAt = 0;
      t.phone.fix(i += 1, Date.now());
      await settle();
    }
    assert.equal(t.state.queued, 2, 'kept: these answers can change');
    assert.match(t.state.lastUploadError, /server error 503/);
    t.server.mode = 'notyours';
    t.state.nextSyncAt = 0;
    await t.resume();
    assert.equal(t.state.queued, 0, 'dropped: no server will ever take these');
  } finally { t.stop(); }
});

test('a ride the office stopped while the phone was away: the phone stops recording and starts nothing new', async () => {
  const t = await launch();
  try {
    t.phone.fix(0, Date.now());
    await settle();
    t.server.rideActive = false;
    t.state.lastSyncAttemptAt = 0;
    t.phone.fix(1, Date.now());
    await settle(60);
    assert.equal(t.state.rideId, null, 'the phone learned the ride is over');
    assert.equal(t.state.watcherId, null, 'and stopped recording');
    assert.ok(t.state.stoppedInfo, 'and tells the driver why');
    const uploads = t.server.uploads.length;
    t.phone.fix(2, Date.now());
    await settle();
    assert.equal(t.server.uploads.length, uploads, 'fixes after the stop are not recorded or sent');
  } finally { t.stop(); }
});

test('reopening the app does not leave a second recorder running', async () => {
  const store = new Map();
  const a = await launch({ store });
  const first = a.state.watcherId;
  a.stop();
  // The screen is recreated; the native service still has the old watcher.
  const b = await launch({ store, server: Object.assign(fakeServer(), { started: true }) });
  try {
    assert.ok(b.phone.seen.removed.includes(first), 'the stale watcher is removed before a new one is added');
    assert.equal(b.phone.seen.added.length, 1);
  } finally { b.stop(); }
});
