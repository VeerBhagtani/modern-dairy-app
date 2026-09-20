/* Modern Drivers — driver app logic.
 *
 * Design rules, in priority order:
 *   1. Never lose a GPS point. Points go into IndexedDB first and are deleted
 *      only when the server confirms them by id. A dead network, a killed app
 *      or a flat battery costs nothing but delay.
 *   2. Never invent a GPS point. Only fixes the OS actually produced are
 *      stored. If the phone gives us nothing, the day has a gap, and the gap is
 *      reported as a gap.
 *   3. Never tell the driver something that is not true. "Tracking" means the
 *      watcher is running AND fixes are arriving; anything else says so.
 *   4. The driver cannot stop a ride. The app does not offer it, and the server
 *      refuses it — see /driver/rides/:id/stop in the backend.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var BRAND = window.BRANDING || {};
  var API = String(CFG.API_BASE || '').replace(/\/+$/, '');

  // ── tiny helpers ───────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var show = function (el, on) { if (el) el.hidden = !on; };
  var text = function (id, v) { var el = $(id); if (el) el.textContent = v; };
  function fmtTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtAgo(ms) {
    if (!ms) return 'never';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  }
  function fmtDur(ms) {
    var m = Math.floor(ms / 60000);
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  // ── persistent state (app-private WebView storage) ─────────────────────
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('md_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('md_' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del: function (k) { try { localStorage.removeItem('md_' + k); } catch (e) {} },
  };

  var state = {
    deviceId: LS.get('deviceId', null),
    tokens: LS.get('tokens', null),
    driver: LS.get('driver', null),
    rideId: LS.get('rideId', null),
    rideStartedAt: LS.get('rideStartedAt', null),
    personalFrom: LS.get('personalFrom', null),
    notice: LS.get('notice', null),
    tracking: { sampleIntervalSec: CFG.SAMPLE_INTERVAL_SEC || 30, maxBatchPoints: CFG.MAX_BATCH_POINTS || 200 },
    watcherId: null,
    lastFixAt: null,
    lastFix: null,
    lastSyncAt: LS.get('lastSyncAt', null),
    sentCount: LS.get('sentCount', 0),
    queued: 0,
    permission: 'unknown',
    gpsEnabled: null,
    online: navigator.onLine,
    stoppedInfo: null,
    starting: false,
  };

  if (!state.deviceId) {
    // A stable per-install id. It scopes the point-id sequence (so two phones
    // can never mint the same point id) and binds the account to this device.
    state.deviceId = 'dev-' + (Date.now().toString(36)) + '-' + Math.random().toString(36).slice(2, 10);
    LS.set('deviceId', state.deviceId);
  }

  // ── point id sequence ──────────────────────────────────────────────────
  // Monotonic and persisted, so a point id is unique for the life of the
  // install even across restarts. This is what makes a replayed upload
  // idempotent on the server instead of double-counting distance.
  function nextPointId() {
    var seq = LS.get('seq', 0) + 1;
    LS.set('seq', seq);
    return state.deviceId + ':' + String(seq).padStart(9, '0');
  }

  // ── IndexedDB queue ────────────────────────────────────────────────────
  var DB_NAME = 'modern-drivers';
  var STORE = 'queue';
  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'clientPointId' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  var queue = {
    put: function (point) { return tx('readwrite', function (s) { s.put(point); }); },
    take: function (n) {
      return db().then(function (d) {
        return new Promise(function (resolve, reject) {
          var out = [];
          var t = d.transaction(STORE, 'readonly');
          var cur = t.objectStore(STORE).openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c || out.length >= n) { resolve(out); return; }
            out.push(c.value);
            c.continue();
          };
          cur.onerror = function () { reject(cur.error); };
        });
      });
    },
    remove: function (ids) { return tx('readwrite', function (s) { ids.forEach(function (id) { s.delete(id); }); }); },
    count: function () {
      return db().then(function (d) {
        return new Promise(function (resolve) {
          var r = d.transaction(STORE, 'readonly').objectStore(STORE).count();
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { resolve(0); };
        });
      });
    },
  };

  // ── API ────────────────────────────────────────────────────────────────
  function apiFetch(path, opts, retryOn401) {
    opts = opts || {};
    if (!API) return Promise.reject(new Error('This build has no server address. Contact the office.'));
    var headers = { 'Content-Type': 'application/json' };
    if (state.tokens && state.tokens.accessToken) headers.Authorization = 'Bearer ' + state.tokens.accessToken;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return { success: false, message: 'Server error ' + res.status }; })
        .then(function (json) {
          if (res.status === 401 && retryOn401 !== false && state.tokens && state.tokens.refreshToken) {
            return refreshToken().then(function (ok) {
              if (!ok) { signOut(); throw new Error(json.message || 'Session expired'); }
              return apiFetch(path, opts, false);
            });
          }
          if (!res.ok || json.success === false) {
            var err = new Error(json.message || ('Request failed (' + res.status + ')'));
            err.status = res.status;
            err.code = json.code;
            err.data = json.data;
            throw err;
          }
          return json.data;
        });
    });
  }

  function refreshToken() {
    return fetch(API + '/driver/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.tokens.refreshToken }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.success) return false;
      state.tokens.accessToken = j.data.accessToken;
      LS.set('tokens', state.tokens);
      return true;
    }).catch(function () { return false; });
  }

  function signOut() {
    state.tokens = null; state.driver = null; state.rideId = null;
    LS.del('tokens'); LS.del('driver'); LS.del('rideId');
    stopWatcher();
    render();
  }

  // ── background geolocation ─────────────────────────────────────────────
  var BG = null;
  function bgPlugin() {
    if (BG) return BG;
    if (window.Capacitor && window.Capacitor.registerPlugin) {
      BG = window.Capacitor.registerPlugin('BackgroundGeolocation');
    }
    return BG;
  }

  var lastKept = null;   // last fix we actually stored

  // Throttle: keep a fix if it is the first, or far enough from the last kept
  // one, or old enough. Keeping every OS fix would flood the queue; keeping
  // only distant ones would lose the dwell evidence that proves a delivery
  // stop. This keeps both, cheaply.
  function shouldKeep(loc) {
    if (!lastKept) return true;
    var dt = (loc.time - lastKept.time) / 1000;
    if (dt >= state.tracking.sampleIntervalSec - 5) return true;
    var dLat = (loc.latitude - lastKept.latitude) * 111320;
    var dLng = (loc.longitude - lastKept.longitude) * 111320 * Math.cos(loc.latitude * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng) >= 25;
  }

  function onLocation(location, error) {
    if (error) {
      if (error.code === 'NOT_AUTHORIZED') {
        state.permission = 'denied';
        reportHealth();
      }
      state.lastError = error.message || String(error.code || error);
      render();
      return;
    }
    if (!location) return;
    state.permission = 'granted';
    state.lastFixAt = Date.now();
    state.lastFix = location;
    if (!state.rideId) return;              // no ride: nothing is ever stored
    if (!shouldKeep(location)) { render(); return; }
    lastKept = location;

    queue.put({
      clientPointId: nextPointId(),
      lat: location.latitude,
      lng: location.longitude,
      // The OS fix time, not the time this callback ran. The server stores its
      // own receipt time separately so a wrong phone clock is detectable.
      deviceTs: location.time || Date.now(),
      accuracyM: location.accuracy == null ? null : Math.round(location.accuracy),
      speedMps: location.speed == null ? null : location.speed,
      headingDeg: location.bearing == null ? null : location.bearing,
      altitudeM: location.altitude == null ? null : location.altitude,
      provider: 'fused',
      // Android's own mock-location flag. Passed through honestly; the server
      // excludes such fixes from distance and flags them.
      mock: location.simulated === true,
    }).then(function () { return queue.count(); })
      .then(function (n) { state.queued = n; render(); if (n >= 10) sync(); });
  }

  function startWatcher() {
    var p = bgPlugin();
    if (!p) { state.lastError = 'Location service is not available in this build.'; render(); return Promise.resolve(); }
    if (state.watcherId) return Promise.resolve();
    return p.addWatcher({
      // Android requires a persistent notification for a foreground location
      // service. The wording is deliberate: the driver should never be unsure
      // whether they are being tracked.
      backgroundTitle: 'Modern Drivers — ride in progress',
      backgroundMessage: 'Your location is being recorded for Modern Dairy deliveries.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
    }, onLocation).then(function (id) {
      state.watcherId = id;
      LS.set('watcherActive', true);
      render();
    }).catch(function (e) {
      state.lastError = e.message || 'Could not start location tracking.';
      render();
    });
  }

  function stopWatcher() {
    var p = bgPlugin();
    if (!p || !state.watcherId) { LS.set('watcherActive', false); return Promise.resolve(); }
    var id = state.watcherId;
    state.watcherId = null;
    LS.set('watcherActive', false);
    return p.removeWatcher({ id: id }).catch(function () {});
  }

  // ── sync ───────────────────────────────────────────────────────────────
  var syncing = false;
  function sync() {
    if (syncing || !state.rideId || !state.tokens) return Promise.resolve();
    syncing = true;
    return queue.take(state.tracking.maxBatchPoints).then(function (points) {
      if (!points.length) return null;
      // Chronological order is preserved because point ids are monotonic and
      // the cursor walks them in key order.
      return apiFetch('/driver/rides/' + state.rideId + '/points', { method: 'POST', body: { points: points } })
        .then(function (data) {
          // Delete ONLY what the server confirmed, plus anything it rejected as
          // permanently malformed — retrying those forever would wedge the queue.
          var done = (data.accepted || []).concat((data.rejected || []).map(function (r) { return r.clientPointId; }).filter(Boolean));
          return queue.remove(done).then(function () {
            state.lastSyncAt = Date.now();
            state.sentCount = (state.sentCount || 0) + (data.accepted || []).length;
            LS.set('lastSyncAt', state.lastSyncAt);
            LS.set('sentCount', state.sentCount);
            if (data.rideActive === false) return checkRide();
            return null;
          });
        });
    }).catch(function (e) {
      if (e.code === 'RIDE_STOPPED') return checkRide();
      // Anything else: keep the points and try again later. This is the normal
      // path in a dead zone and is not an error worth shouting about.
      state.lastSyncError = e.message;
      return null;
    }).then(function () {
      return queue.count();
    }).then(function (n) {
      state.queued = n;
      syncing = false;
      render();
    }).catch(function () { syncing = false; });
  }

  // ── ride ───────────────────────────────────────────────────────────────
  function startRide() {
    if (state.starting) return;
    if (!API) { state.startError = 'This build has no server address. Contact the office.'; render(); return; }
    state.starting = true; state.startError = null; render();
    apiFetch('/driver/rides/start', { method: 'POST', body: { deviceId: state.deviceId, appVersion: APP_VERSION } })
      .then(function (data) {
        state.rideId = data.rideId;
        state.rideStartedAt = data.startedAt;
        state.stoppedInfo = null;
        LS.set('rideId', state.rideId);
        LS.set('rideStartedAt', state.rideStartedAt);
        return startWatcher();
      })
      .catch(function (e) { state.startError = e.message; })
      .then(function () { state.starting = false; render(); });
  }

  // Ask the server whether the ride is still running. The server is the only
  // authority: the office stops rides, and the phone finds out from here.
  function checkRide() {
    if (!state.tokens) return Promise.resolve();
    return apiFetch('/driver/rides/active').then(function (data) {
      if (data.active) {
        state.rideId = data.rideId;
        state.rideStartedAt = data.startedAt;
        LS.set('rideId', state.rideId);
        LS.set('rideStartedAt', state.rideStartedAt);
        state.stoppedInfo = null;
        return startWatcher();
      }
      if (state.rideId) {
        state.stoppedInfo = {
          stoppedAt: data.stoppedAt, by: data.stoppedBy, reason: data.reason, kind: data.kind,
        };
      }
      state.rideId = null;
      LS.del('rideId');
      state.personalFrom = null; LS.del('personalFrom');
      return stopWatcher();
    }).catch(function () { /* offline: keep tracking, the ride is still ours */ })
      .then(render);
  }

  // ── personal trip declaration ──────────────────────────────────────────
  function togglePersonal() {
    if (!state.rideId) return;
    if (!state.personalFrom) {
      state.personalFrom = Date.now();
      LS.set('personalFrom', state.personalFrom);
      render();
      return;
    }
    var from = state.personalFrom;
    var to = Date.now();
    state.personalFrom = null;
    LS.del('personalFrom');
    render();
    apiFetch('/driver/rides/' + state.rideId + '/declare', {
      method: 'POST',
      body: { kind: 'personal', fromTs: from, toTs: to },
    }).catch(function (e) {
      // Declarations are advisory and the office can always add one later, so a
      // failure here is reported but never blocks the driver.
      state.lastError = 'Could not save the personal stretch: ' + e.message;
      render();
    });
  }

  // ── health ─────────────────────────────────────────────────────────────
  function reportHealth() {
    if (!state.tokens) return;
    apiFetch('/driver/health', {
      method: 'POST',
      body: {
        locationPermission: state.permission,
        gpsEnabled: state.gpsEnabled,
        online: navigator.onLine,
        queuedPoints: state.queued,
        appVersion: APP_VERSION,
      },
    }).catch(function () {});
  }

  // ── registration ───────────────────────────────────────────────────────
  // Name and phone number. No password, no code. The phone number is the
  // account, so a driver who reinstalls or changes handset types the same two
  // things and carries straight on.
  function enrol() {
    var name = $('inName').value.trim();
    var phone = $('inPhone').value.replace(/\D/g, '').slice(-10);
    var err = $('enrolErr');
    err.hidden = true;
    if (!name) { err.textContent = 'Please enter your name.'; err.hidden = false; return; }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      err.textContent = 'Please enter your 10-digit mobile number.';
      err.hidden = false;
      return;
    }
    $('btnEnrol').disabled = true;
    apiFetch('/driver/register', {
      method: 'POST',
      body: { name: name, phone: phone, deviceId: state.deviceId, appVersion: APP_VERSION },
    })
      .then(function (data) {
        state.tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken };
        state.driver = data.driver;
        state.tracking = data.tracking || state.tracking;
        state.notice = data.privacyNotice;
        LS.set('tokens', state.tokens); LS.set('driver', state.driver); LS.set('notice', state.notice);
        return checkRide();
      })
      .catch(function (e) { err.textContent = e.message; err.hidden = false; })
      .then(function () { $('btnEnrol').disabled = false; render(); });
  }

  // ── UI ─────────────────────────────────────────────────────────────────
  function applyBranding() {
    var t = BRAND.theme || {};
    var root = document.documentElement.style;
    var map = { brand: '--brand', brandDark: '--brand-dark', accent: '--accent', ok: '--ok', okTint: '--ok-tint', warn: '--warn', warnTint: '--warn-tint', bad: '--bad', badTint: '--bad-tint', bg: '--bg', surface: '--surface', line: '--line', ink: '--ink', ink2: '--ink-2' };
    Object.keys(map).forEach(function (k) { if (t[k]) root.setProperty(map[k], t[k]); });
    if (BRAND.appName) { text('brandName', BRAND.appName); document.title = BRAND.appName; }
    if (BRAND.companyName) text('brandCompany', BRAND.companyName);
    if (BRAND.logo) $('brandLogo').src = BRAND.logo;
  }

  function noticeHtml(notice) {
    if (!notice) return '<p>Your location is recorded only while a ride is running.</p>';
    var ul = notice.points.map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('');
    return '<b>' + escapeHtml(notice.title) + '</b><ul>' + ul + '</ul>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  }

  function trackingStatus() {
    if (!state.rideId) return { cls: 'off', title: 'Not tracking', sub: 'Press Start Ride when you leave Modern Dairy.' };
    if (state.permission === 'denied') return { cls: 'bad', title: 'Tracking stopped', sub: 'Location permission is off. Tap "Fix location permission" below — the office can see this.' };
    if (state.gpsEnabled === false) return { cls: 'bad', title: 'Tracking paused', sub: 'GPS is switched off on this phone. Switch it on to continue.' };
    if (!state.watcherId) return { cls: 'warn', title: 'Starting…', sub: 'Waiting for the phone to allow location.' };
    var age = state.lastFixAt ? (Date.now() - state.lastFixAt) / 1000 : null;
    if (age == null) return { cls: 'warn', title: 'Waiting for GPS', sub: 'No position yet. This can take a minute indoors.' };
    if (age > 300) return { cls: 'warn', title: 'Tracking — weak signal', sub: 'No new position for ' + fmtAgo(state.lastFixAt) + '. Your route may have a gap.' };
    if (!navigator.onLine && state.queued > 0) return { cls: 'warn', title: 'Tracking — offline', sub: state.queued + ' positions saved on the phone. They will be sent when the network is back.' };
    return { cls: 'on', title: 'Tracking is on', sub: 'Your ride is being recorded. Only the office can stop it.' };
  }

  function render() {
    var enrolled = !!(state.tokens && state.driver);
    show($('screenLoading'), false);
    show($('screenEnrol'), !enrolled);
    show($('screenMain'), enrolled);

    if (!enrolled) {
      $('enrolNotice').innerHTML = noticeHtml(state.notice);
      return;
    }

    var s = trackingStatus();
    var card = $('statusCard');
    card.className = 'status ' + s.cls;
    text('statusText', s.title);
    text('statusSub', s.sub);

    show($('btnStart'), !state.rideId);
    $('btnStart').disabled = state.starting;
    $('btnStart').textContent = state.starting ? 'Starting…' : 'Start Ride';
    show($('activeBox'), !!state.rideId);

    var st = $('startErr');
    st.hidden = !state.startError;
    st.textContent = state.startError || '';

    var banner = $('stoppedBanner');
    if (state.stoppedInfo && !state.rideId) {
      banner.hidden = false;
      banner.innerHTML = '<b>The office stopped your ride'
        + (state.stoppedInfo.stoppedAt ? ' at ' + fmtTime(state.stoppedInfo.stoppedAt) : '') + '.</b><br>'
        + (state.stoppedInfo.kind === 'timeout'
          ? 'It was closed automatically because it had been running a long time.'
          : escapeHtml(state.stoppedInfo.reason || 'No reason was recorded.'));
    } else banner.hidden = true;

    text('rideStarted', fmtTime(state.rideStartedAt));
    text('rideFor', state.rideStartedAt ? fmtDur(Date.now() - state.rideStartedAt) : '—');
    text('ridePoints', String(state.sentCount || 0));
    text('rideQueued', String(state.queued || 0));
    text('rideLast', state.lastFixAt ? fmtAgo(state.lastFixAt) : 'waiting…');

    var pState = $('personalState');
    var pBtn = $('btnPersonal');
    if (state.personalFrom) {
      pState.innerHTML = '<b>Personal stretch running</b> since ' + fmtTime(state.personalFrom)
        + '. These kilometres will not be counted as Modern Dairy business.';
      pBtn.textContent = 'End personal stretch';
    } else {
      pState.textContent = 'Mark the stretch you are doing your own Porter work, so it is not counted as Modern Dairy kilometres.';
      pBtn.textContent = 'Start a personal stretch';
    }
    pBtn.disabled = !state.rideId;

    var permPill = state.permission === 'granted' ? '<span class="pill ok">Allowed</span>'
      : state.permission === 'denied' ? '<span class="pill bad">Blocked</span>'
        : '<span class="pill warn">Not checked</span>';
    $('hPerm').innerHTML = permPill;
    $('hGps').innerHTML = state.gpsEnabled === false ? '<span class="pill bad">Off</span>'
      : state.gpsEnabled === true ? '<span class="pill ok">On</span>' : '<span class="pill warn">Unknown</span>';
    $('hNet').innerHTML = navigator.onLine ? '<span class="pill ok">Online</span>' : '<span class="pill warn">Offline</span>';
    text('hSync', state.lastSyncAt ? fmtAgo(state.lastSyncAt) : 'not yet');
    show($('btnFix'), state.permission === 'denied');

    text('accName', state.driver.name || '—');
    text('accCode', state.driver.driverCode || '—');
    var phoneEl = $('accPhone');
    if (phoneEl) phoneEl.textContent = state.driver.phone || '—';
  }

  // ── sheet ──────────────────────────────────────────────────────────────
  function openSheet(title, html) {
    $('sheetTitle').textContent = title;
    $('sheetBody').innerHTML = html;
    $('sheetBg').classList.add('on');
  }
  $('sheetClose').addEventListener('click', function () { $('sheetBg').classList.remove('on'); });
  $('sheetBg').addEventListener('click', function (e) { if (e.target === $('sheetBg')) $('sheetBg').classList.remove('on'); });

  // ── boot ───────────────────────────────────────────────────────────────
  var APP_VERSION = '1.0.0';

  applyBranding();
  render();

  $('btnEnrol').addEventListener('click', enrol);
  $('inPhone').addEventListener('input', function (e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
  });
  $('inPhone').addEventListener('keydown', function (e) { if (e.key === 'Enter') enrol(); });
  $('btnStart').addEventListener('click', startRide);
  $('btnPersonal').addEventListener('click', togglePersonal);
  $('btnNotice').addEventListener('click', function () { openSheet('Location tracking', noticeHtml(state.notice)); });
  $('btnFix').addEventListener('click', function () {
    var p = bgPlugin();
    if (p && p.openSettings) p.openSettings();
    else openSheet('Location permission', '<p>Open Android Settings → Apps → Modern Drivers → Permissions → Location, and choose <b>Allow all the time</b>.</p>');
  });
  window.addEventListener('online', function () { state.online = true; sync(); render(); });
  window.addEventListener('offline', function () { state.online = false; render(); });

  // The app resuming is the moment to re-check everything: the ride may have
  // been stopped, permission may have been revoked, the queue may have grown.
  function resumeChecks() {
    queue.count().then(function (n) { state.queued = n; render(); });
    checkRide();
    sync();
  }
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', function (s) { if (s.isActive) resumeChecks(); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resumeChecks(); });

  if (state.tokens) {
    // Refresh the profile (name, thresholds, notice wording) and re-attach to
    // the ride. An app restart mid-ride must resume tracking, not lose it.
    apiFetch('/driver/me').then(function (data) {
      state.driver = data.driver;
      state.tracking = data.tracking || state.tracking;
      state.notice = data.privacyNotice;
      LS.set('driver', state.driver); LS.set('notice', state.notice);
      text('stopRule', data.rideControl || 'Only the Modern Dairy office can stop a ride.');
    }).catch(function () { /* offline: use the stored copy */ })
      .then(resumeChecks);
  } else {
    render();
  }

  setInterval(function () { sync(); }, (CFG.SYNC_INTERVAL_SEC || 45) * 1000);
  setInterval(function () { checkRide(); }, (CFG.RIDE_POLL_SEC || 60) * 1000);
  setInterval(function () { reportHealth(); }, 5 * 60 * 1000);
  setInterval(render, 15000);

  // Expose a small surface for the instrumented Android tests, and for a
  // support call where the office needs to see what the phone thinks.
  window.ModernDrivers = {
    state: state,
    queue: queue,
    sync: sync,
    checkRide: checkRide,
    diagnostics: function () {
      return {
        deviceId: state.deviceId, rideId: state.rideId, queued: state.queued,
        lastFixAt: state.lastFixAt, lastSyncAt: state.lastSyncAt,
        permission: state.permission, watcher: !!state.watcherId, online: navigator.onLine,
      };
    },
  };
})();
