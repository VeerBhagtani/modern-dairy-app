// The driver app's location recorder, driven the way a phone drives it.
//
// This file exists because of three failed fixes in a row, all of them written
// against the wrong half of the plugin's API.
//
// @capacitor-community/background-geolocation's addWatcher is declared
// RETURN_CALLBACK. Capacitor's bridge therefore resolves its promise with a
// callback-id string the moment the message is posted to Android, and never
// rejects it — every refusal the plugin makes (a denied permission, the
// phone's location switch off, the service not yet bound) is delivered as the
// SECOND ARGUMENT of the watcher callback instead. A .catch() on addWatcher
// cannot fire for any of them.
//
// Nothing in the app's types or its tests said so, and the bug it caused was
// vicious: the resolved id was stored, the id made startWatcher return early,
// and one refusal stopped the app from ever asking the phone again for the
// rest of the session. The driver turned location on, came back, and nothing
// happened. Three rounds were spent on that.
//
// So the app is loaded here against a fake Capacitor that behaves the way the
// real bridge behaves — resolve the promise, report the failure through the
// callback — and the tests below assert on what the driver ends up seeing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'app/www/app.js'), 'utf8');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Captured before the app's globals are swapped in, so the fakes below can use
// the real timers without calling themselves.
const realInterval = globalThis.setInterval;
const realTimeout = globalThis.setTimeout;

/* A DOM with no opinions: every element exists, remembers what was set on it,
 * and records its listeners so a test can press a button. The app only ever
 * reads back what it wrote, so this is enough to run it for real rather than
 * reaching inside it. */
function fakeDom() {
  const elements = new Map();
  const make = (id) => {
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      handlers: {},
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, contains: () => false },
      addEventListener(kind, fn) { (this.handlers[kind] = this.handlers[kind] || []).push(fn); },
      removeEventListener() {},
      appendChild() {}, remove() {}, setAttribute() {}, focus() {},
      querySelectorAll: () => [],
      click() { (this.handlers.click || []).forEach((fn) => fn({ target: el })); },
    };
    return el;
  };
  return {
    get(id) {
      if (!elements.has(id)) elements.set(id, make(id));
      return elements.get(id);
    },
    document: {
      documentElement: { style: { setProperty() {} } },
      hidden: false,
      getElementById(id) { return this.__get(id); },
      querySelectorAll: () => [],
      createElement: () => make('created'),
      addEventListener() {},
      body: { appendChild() {}, removeChild() {} },
    },
    elements,
  };
}

/* Capacitor as the bridge actually behaves. addWatcher resolves with an id and
 * never rejects; failures go to the callback. Getting that backwards is the
 * whole reason this file exists, so the fake is deliberately faithful to it. */
function fakeCapacitor() {
  const seen = { watchers: [], removed: [], permissionRequests: 0, positions: 0 };
  let callback = null;
  let n = 0;
  let position = { coords: { latitude: 18.5204, longitude: 73.8567, accuracy: 9 } };

  const bg = {
    addWatcher(options, cb) {
      seen.watchers.push(options);
      callback = cb;
      return Promise.resolve('watcher-' + (++n));
    },
    removeWatcher({ id }) { seen.removed.push(id); return Promise.resolve(); },
    openSettings() { return Promise.resolve(); },
  };
  const geolocation = {
    requestPermissions() { seen.permissionRequests += 1; return Promise.resolve({ location: 'granted' }); },
    getCurrentPosition() {
      seen.positions += 1;
      return position ? Promise.resolve(position) : Promise.reject(new Error('no position'));
    },
  };

  return {
    seen,
    setPosition(p) { position = p; },
    // What Android does when it refuses: resolve, then report through the callback.
    refuse(message, code) { callback(null, Object.assign(new Error(message), { code })); },
    report(location) { callback(location); },
    capacitor: {
      registerPlugin(name) {
        if (name === 'BackgroundGeolocation') return bg;
        if (name === 'Geolocation') return geolocation;
        return {};
      },
      Plugins: {},
    },
  };
}

/* Load the app into this process, with a name already entered and a ride
 * already started, which is the state a driver is in when location matters. */
async function launch() {
  const dom = fakeDom();
  dom.document.__get = dom.get;
  const cap = fakeCapacitor();
  const store = new Map();
  const timers = [];

  const win = {
    // No server: the location path, on its own. The retry delay is shortened
    // so the "service not bound yet" case can be observed without waiting.
    APP_CONFIG: { API_BASE: '', WATCHER_RETRY_MS: 5 },
    BRANDING: {},
    Capacitor: cap.capacitor,
    addEventListener() {},
  };

  const previous = {};
  const globals = {
    window: win,
    document: dom.document,
    navigator: { onLine: true, geolocation: null },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    indexedDB: { open() { return { onsuccess: null, onerror: null, onupgradeneeded: null }; } },
  };
  for (const [k, v] of Object.entries(globals)) {
    previous[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }

  // The app sets sync and poll timers as it loads. Left as they are they hold
  // the test process open, so they are unreferenced as they are created — and
  // only while the app is loading, since patching a global timer for longer
  // than that breaks the test runner's own waiting.
  globalThis.setInterval = (fn, ms) => { const t = realInterval(fn, ms); t.unref?.(); timers.push(t); return t; };
  try {
    // eslint-disable-next-line no-eval
    (0, eval)(SOURCE);
  } finally {
    globalThis.setInterval = realInterval;
  }

  const app = win.ModernDrivers;
  const el = dom.get;

  el('inName').value = 'Ramesh';
  el('btnName').click();
  await tick();
  el('btnStart').click();
  await tick(); await tick();

  return {
    app, cap, el,
    state: app.state,
    stop() {
      timers.forEach(clearInterval);
      for (const [k, d] of Object.entries(previous)) {
        if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
      }
    },
  };
}

test('a ride starts the recorder, with the notification that keeps it alive', async () => {
  const t = await launch();
  try {
    assert.equal(t.cap.seen.watchers.length, 1, 'pressing Start Ride adds a watcher');
    // backgroundMessage is what makes the plugin run a foreground service, and
    // the foreground service is the only reason recording survives the screen
    // locking. Dropping it to "simplify" the options would silently halve a
    // driver's day.
    assert.ok(t.cap.seen.watchers[0].backgroundMessage, 'the foreground service is requested');
    assert.equal(t.state.watcherId, 'watcher-1');
    assert.equal(t.state.startError, null);
  } finally { t.stop(); }
});

test('a refused permission reported through the callback is not lost', async () => {
  const t = await launch();
  try {
    t.cap.refuse('User denied location permission', 'NOT_AUTHORIZED');
    await tick();
    assert.equal(t.state.permission, 'denied');
    assert.match(t.state.startError, /not allowed to use location/i);
    assert.match(t.state.lastPluginError, /NOT_AUTHORIZED/);
  } finally { t.stop(); }
});

test('the phone\'s own location switch is not reported as the app being refused', async () => {
  // Both arrive as NOT_AUTHORIZED and the remedies are opposite. Telling a
  // driver whose location is already on to go and switch it on is how the app
  // gets blamed for the phone.
  const t = await launch();
  try {
    t.cap.refuse('Location services disabled.', 'NOT_AUTHORIZED');
    await tick();
    assert.equal(t.state.permission, 'device-off');
    assert.match(t.state.startError, /phone's own location switch/i);
    assert.doesNotMatch(t.state.startError, /Fix permission/);
  } finally { t.stop(); }
});

test('a failed watcher is torn down rather than left holding the id', async () => {
  // The plugin releases its saved call when it refuses, so that watcher can
  // never deliver a fix again. Keeping its id would be recording a thing that
  // is not happening.
  const t = await launch();
  try {
    t.cap.refuse('User denied location permission', 'NOT_AUTHORIZED');
    await tick();
    assert.equal(t.state.watcherId, null);
    assert.deepEqual(t.cap.seen.removed, ['watcher-1']);
  } finally { t.stop(); }
});

test('one refusal does not stop the app asking again', async () => {
  // This is the bug the office actually reported: turn location on, come back,
  // and nothing happens for the rest of the session.
  const t = await launch();
  try {
    t.cap.refuse('Location services disabled.', 'NOT_AUTHORIZED');
    await tick();

    t.el('btnStart').click();   // the driver tries again
    await tick(); await tick();

    assert.equal(t.cap.seen.watchers.length, 2, 'a second attempt reaches the plugin');
    assert.equal(t.state.watcherId, 'watcher-2');
  } finally { t.stop(); }
});

test('a fix arriving is what clears a refusal, not the app deciding it is fine', async () => {
  const t = await launch();
  try {
    t.cap.refuse('Location services disabled.', 'NOT_AUTHORIZED');
    await tick();
    assert.equal(t.state.permission, 'device-off');

    t.el('btnStart').click();
    await tick(); await tick();
    t.cap.report({ latitude: 18.5204, longitude: 73.8567, accuracy: 9, time: Date.now(), bearing: null, speed: 0 });
    await tick();

    assert.equal(t.state.permission, 'granted');
    assert.equal(t.state.startError, null);
    assert.deepEqual(t.state.lastFix, { lat: 18.5204, lng: 73.8567 });
  } finally { t.stop(); }
});

test('the service not being bound yet is a retry, not an error shown to the driver', async () => {
  // The plugin binds its service asynchronously as the app loads. Asking a
  // moment too early is a race; saying "could not start location" for it would
  // send somebody to Settings to fix nothing.
  const t = await launch();
  try {
    t.cap.refuse('Service not running.', undefined);
    await tick();
    assert.equal(t.state.startError, null, 'nothing alarming is shown');
    await new Promise((r) => realTimeout(r, 30));
    assert.equal(t.cap.seen.watchers.length, 2, 'it tries again by itself');
  } finally { t.stop(); }
});

test('the app asks the phone for permission as soon as it is opened', async () => {
  // Deliberate: the Android dialog should be dealt with in the office, not at
  // the wheel with a round already late.
  const t = await launch();
  try {
    assert.ok(t.cap.seen.permissionRequests >= 1);
  } finally { t.stop(); }
});
