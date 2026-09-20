/* Modern Drivers — driver app.
 *
 * The whole app is two screens: type your name, press Start Ride. Everything
 * else is status the driver can glance at and ignore.
 *
 * Rules this file keeps:
 *   1. Never lose a fix. Points go to IndexedDB first and are deleted only when
 *      the server confirms them by id.
 *   2. Never invent one. Only fixes the OS actually produced are stored. If the
 *      phone gives nothing, the day has a gap and it is reported as a gap.
 *   3. Never claim more than is true. "Tracking" means the watcher is running
 *      AND fixes are arriving; anything else says what is actually wrong.
 *   4. The driver cannot stop a ride. No button here, and the server refuses.
 *
 * It works with no server. Location is recorded on the phone and drawn on the
 * map, and the app says plainly that nothing has reached the office yet. That
 * is not a demo mode — the GPS is real and it is kept — it is just not synced
 * until there is somewhere to sync to.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var BRAND = window.BRANDING || {};
  var API = String(CFG.API_BASE || '').replace(/\/+$/, '');
  var HAS_SERVER = !!API;
  var APP_VERSION = '2.0.0';

  var $ = function (id) { return document.getElementById(id); };
  var show = function (el, on) { if (el) el.hidden = !on; };
  var text = function (id, v) { var e = $(id); if (e) e.textContent = v; };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };

  // ── stored state ───────────────────────────────────────────────────────
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('md_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('md_' + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem('md_' + k); } catch (e) {} },
  };

  var state = {
    deviceId: LS.get('deviceId', null),
    name: LS.get('name', null),
    driver: LS.get('driver', null),
    tokens: LS.get('tokens', null),
    rideId: LS.get('rideId', null),
    rideStartedAt: LS.get('rideStartedAt', null),
    localRide: LS.get('localRide', null),      // a ride running with no server
    personalFrom: LS.get('personalFrom', null),
    notice: LS.get('notice', null),
    tracking: { sampleIntervalSec: CFG.SAMPLE_INTERVAL_SEC || 30, maxBatchPoints: CFG.MAX_BATCH_POINTS || 200 },
    watcherId: null,
    lastFix: null,
    lastFixAt: null,
    distanceM: LS.get('distanceM', 0),
    pointCount: LS.get('pointCount', 0),
    queued: 0,
    lastSyncAt: LS.get('lastSyncAt', null),
    permission: 'unknown',
    starting: false,
    startError: null,
    stoppedInfo: null,
    route: [],          // [lng,lat] for the map line
  };

  if (!state.deviceId) {
    state.deviceId = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    LS.set('deviceId', state.deviceId);
  }

  var riding = function () { return !!(state.rideId || state.localRide); };

  function nextPointId() {
    var seq = LS.get('seq', 0) + 1;
    LS.set('seq', seq);
    // Monotonic and persisted, so a replayed upload overwrites itself on the
    // server instead of double-counting the kilometres.
    return state.deviceId + ':' + String(seq).padStart(9, '0');
  }

  // ── distance ───────────────────────────────────────────────────────────
  var R = 6371008.8;
  function haversine(a, b) {
    var t = Math.PI / 180;
    var dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ── IndexedDB queue ────────────────────────────────────────────────────
  var DB = 'modern-drivers', STORE = 'queue', dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'clientPointId' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  var queue = {
    put: function (p) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(STORE, 'readwrite');
          t.objectStore(STORE).put(p);
          t.oncomplete = res; t.onerror = function () { rej(t.error); };
        });
      });
    },
    take: function (n) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var out = [], c = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
          c.onsuccess = function () {
            var cur = c.result;
            if (!cur || out.length >= n) return res(out);
            out.push(cur.value); cur.continue();
          };
          c.onerror = function () { rej(c.error); };
        });
      });
    },
    remove: function (ids) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(STORE, 'readwrite'), s = t.objectStore(STORE);
          ids.forEach(function (i) { s.delete(i); });
          t.oncomplete = res; t.onerror = function () { rej(t.error); };
        });
      });
    },
    count: function () {
      return db().then(function (d) {
        return new Promise(function (res) {
          var r = d.transaction(STORE, 'readonly').objectStore(STORE).count();
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { res(0); };
        });
      });
    },
  };

  // ── API ────────────────────────────────────────────────────────────────
  function apiFetch(path, opts, retry) {
    opts = opts || {};
    if (!HAS_SERVER) return Promise.reject(new Error('No server configured'));
    var h = { 'Content-Type': 'application/json' };
    if (state.tokens && state.tokens.accessToken) h.Authorization = 'Bearer ' + state.tokens.accessToken;
    return fetch(API + path, {
      method: opts.method || 'GET', headers: h,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return { success: false, message: 'Server error ' + res.status }; })
        .then(function (j) {
          if (res.status === 401 && retry !== false && state.tokens && state.tokens.refreshToken) {
            return refresh().then(function (ok) {
              if (!ok) throw new Error(j.message || 'Session expired');
              return apiFetch(path, opts, false);
            });
          }
          if (!res.ok || j.success === false) {
            var e = new Error(j.message || ('Request failed (' + res.status + ')'));
            e.status = res.status; e.code = j.code; e.data = j.data;
            throw e;
          }
          return j.data;
        });
    });
  }
  function refresh() {
    return fetch(API + '/driver/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.tokens.refreshToken }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.success) return false;
      state.tokens.accessToken = j.data.accessToken;
      LS.set('tokens', state.tokens);
      return true;
    }).catch(function () { return false; });
  }

  // ── map ────────────────────────────────────────────────────────────────
  // MapLibre GL with OpenFreeMap tiles: open data, no API key, no billing
  // account, no per-view charge. The style URL below is the only line that
  // knows which map provider this is.
  var map = null, marker = null, mapReady = false, followMap = true;
  function initMap() {
    if (map || !window.maplibregl) return;
    try { if (maplibregl.setWorkerUrl) maplibregl.setWorkerUrl('vendor/maplibre/maplibre-gl-csp-worker.js'); } catch (e) {}
    try {
      map = new maplibregl.Map({
        container: 'map',
        style: CFG.MAP_STYLE || 'https://tiles.openfreemap.org/styles/liberty',
        center: state.lastFix ? [state.lastFix.lng, state.lastFix.lat] : (CFG.MAP_CENTER || [73.8567, 18.5204]),
        zoom: 15,
        attributionControl: true,
      });
      map.on('load', function () {
        mapReady = true;
        map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: state.route } } });
        map.addLayer({
          id: 'route-line', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#1B2A6B', 'line-width': 5, 'line-opacity': .85 },
        });
        drawRoute();
      });
      // Panning turns off follow, so the driver can look ahead without the map
      // yanking back every thirty seconds.
      map.on('dragstart', function () { followMap = false; });
    } catch (e) { map = null; }
  }
  function drawRoute() {
    if (!map || !mapReady) return;
    var src = map.getSource('route');
    if (src) src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: state.route } });
    var last = state.route[state.route.length - 1];
    if (!last) return;
    if (!marker) {
      var el = document.createElement('div');
      el.style.cssText = 'width:20px;height:20px;border-radius:50%;background:#1B2A6B;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.4)';
      marker = new maplibregl.Marker({ element: el }).setLngLat(last).addTo(map);
    } else marker.setLngLat(last);
    if (followMap) map.easeTo({ center: last, duration: 600 });
  }

  // ── tracking ───────────────────────────────────────────────────────────
  var BG = null;
  function bg() {
    if (!BG && window.Capacitor && window.Capacitor.registerPlugin) {
      BG = window.Capacitor.registerPlugin('BackgroundGeolocation');
    }
    return BG;
  }

  var lastKept = null;
  function shouldKeep(loc) {
    if (!lastKept) return true;
    var dt = (loc.time - lastKept.time) / 1000;
    if (dt >= state.tracking.sampleIntervalSec - 5) return true;
    return haversine({ lat: lastKept.latitude, lng: lastKept.longitude },
      { lat: loc.latitude, lng: loc.longitude }) >= 25;
  }

  function onLocation(location, error) {
    if (error) {
      if (error.code === 'NOT_AUTHORIZED') state.permission = 'denied';
      state.lastError = error.message || String(error.code || error);
      render();
      return;
    }
    if (!location) return;
    state.permission = 'granted';
    state.lastFix = { lat: location.latitude, lng: location.longitude };
    state.lastFixAt = Date.now();
    if (!riding()) { render(); return; }
    if (!shouldKeep(location)) { render(); return; }

    // Distance, filtered the same way the server does it: movement under 12 m
    // between fixes is jitter while parked, not travel.
    if (lastKept) {
      var d = haversine({ lat: lastKept.latitude, lng: lastKept.longitude },
        { lat: location.latitude, lng: location.longitude });
      if (d >= 12 && d < 3000) {
        state.distanceM += d;
        LS.set('distanceM', state.distanceM);
      }
    }
    lastKept = location;

    state.route.push([location.longitude, location.latitude]);
    if (state.route.length > 5000) state.route = state.route.slice(-5000);
    drawRoute();

    state.pointCount += 1;
    LS.set('pointCount', state.pointCount);

    queue.put({
      clientPointId: nextPointId(),
      lat: location.latitude,
      lng: location.longitude,
      deviceTs: location.time || Date.now(),
      accuracyM: location.accuracy == null ? null : Math.round(location.accuracy),
      speedMps: location.speed == null ? null : location.speed,
      headingDeg: location.bearing == null ? null : location.bearing,
      altitudeM: location.altitude == null ? null : location.altitude,
      provider: 'fused',
      // Android's own mock-location flag, passed through honestly. The server
      // excludes such fixes from distance and flags them.
      mock: location.simulated === true,
    }).then(function () { return queue.count(); })
      .then(function (n) { state.queued = n; render(); if (HAS_SERVER && n >= 10) sync(); });
  }

  function startWatcher() {
    var p = bg();
    if (!p) { state.startError = 'Location is not available in this build.'; render(); return Promise.resolve(); }
    if (state.watcherId) return Promise.resolve();
    return p.addWatcher({
      // Android requires a permanent notification for a foreground location
      // service. The wording is deliberate: the driver should never be unsure
      // whether they are being recorded.
      backgroundTitle: 'Modern Drivers — ride in progress',
      backgroundMessage: 'Your route is being recorded.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
    }, onLocation).then(function (id) { state.watcherId = id; render(); })
      .catch(function (e) { state.startError = e.message || 'Could not start location.'; render(); });
  }
  function stopWatcher() {
    var p = bg();
    if (!p || !state.watcherId) return Promise.resolve();
    var id = state.watcherId;
    state.watcherId = null;
    return p.removeWatcher({ id: id }).catch(function () {});
  }

  // ── sync ───────────────────────────────────────────────────────────────
  var syncing = false;
  function sync() {
    if (!HAS_SERVER || syncing || !state.rideId || !state.tokens) return Promise.resolve();
    syncing = true;
    return queue.take(state.tracking.maxBatchPoints).then(function (pts) {
      if (!pts.length) return null;
      return apiFetch('/driver/rides/' + state.rideId + '/points', { method: 'POST', body: { points: pts } })
        .then(function (data) {
          // Delete only what the server confirmed, plus anything it rejected as
          // permanently malformed — retrying those forever would wedge the queue.
          var done = (data.accepted || []).concat((data.rejected || [])
            .map(function (r) { return r.clientPointId; }).filter(Boolean));
          return queue.remove(done).then(function () {
            state.lastSyncAt = Date.now();
            LS.set('lastSyncAt', state.lastSyncAt);
            if (data.rideActive === false) return checkRide();
            return null;
          });
        });
    }).catch(function (e) {
      if (e.code === 'RIDE_STOPPED') return checkRide();
      return null;  // a dead zone is normal; keep the points and retry later
    }).then(function () { return queue.count(); })
      .then(function (n) { state.queued = n; syncing = false; render(); })
      .catch(function () { syncing = false; });
  }

  // ── name ───────────────────────────────────────────────────────────────
  function saveName() {
    var name = $('inName').value.trim();
    var err = $('nameErr');
    err.hidden = true;
    if (name.length < 2) { err.textContent = 'Please enter your name.'; err.hidden = false; return; }

    state.name = name;
    LS.set('name', name);

    if (!HAS_SERVER) {
      // Nothing to register with yet. The app still works: it records the
      // route on the phone and says so.
      state.driver = { name: name, driverCode: null };
      LS.set('driver', state.driver);
      render();
      return;
    }

    $('btnName').disabled = true;
    $('btnName').textContent = 'Please wait…';
    apiFetch('/driver/register', { method: 'POST', body: { name: name, deviceId: state.deviceId, appVersion: APP_VERSION } })
      .then(function (data) {
        state.tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken };
        state.driver = data.driver;
        state.tracking = data.tracking || state.tracking;
        state.notice = data.privacyNotice;
        LS.set('tokens', state.tokens); LS.set('driver', state.driver); LS.set('notice', state.notice);
        return checkRide();
      })
      .catch(function (e) {
        // A driver standing in a yard with no signal should still be able to
        // get on with the day; the app registers on its next connection.
        state.driver = { name: name, driverCode: null };
        LS.set('driver', state.driver);
        err.textContent = e.message + ' — you can still start; it will connect when there is signal.';
        err.hidden = false;
      })
      .then(function () {
        $('btnName').disabled = false;
        $('btnName').textContent = 'Continue';
        render();
      });
  }

  // ── ride ───────────────────────────────────────────────────────────────
  function startRide() {
    if (state.starting) return;
    state.starting = true; state.startError = null;
    state.distanceM = 0; state.pointCount = 0; state.route = []; lastKept = null;
    LS.set('distanceM', 0); LS.set('pointCount', 0);
    render();

    var begin = function () {
      initMap();
      return startWatcher();
    };

    if (!HAS_SERVER) {
      state.localRide = { startedAt: Date.now() };
      state.rideStartedAt = state.localRide.startedAt;
      LS.set('localRide', state.localRide);
      LS.set('rideStartedAt', state.rideStartedAt);
      state.stoppedInfo = null;
      begin().then(function () { state.starting = false; render(); });
      return;
    }

    apiFetch('/driver/rides/start', { method: 'POST', body: { deviceId: state.deviceId, appVersion: APP_VERSION } })
      .then(function (data) {
        state.rideId = data.rideId;
        state.rideStartedAt = data.startedAt;
        state.stoppedInfo = null;
        LS.set('rideId', state.rideId); LS.set('rideStartedAt', state.rideStartedAt);
        return begin();
      })
      .catch(function (e) { state.startError = e.message; })
      .then(function () { state.starting = false; render(); });
  }

  // The server is the only authority on whether a ride is running. The office
  // stops rides; the phone finds out from here.
  function checkRide() {
    if (!HAS_SERVER || !state.tokens) return Promise.resolve();
    return apiFetch('/driver/rides/active').then(function (data) {
      if (data.active) {
        state.rideId = data.rideId;
        state.rideStartedAt = data.startedAt;
        LS.set('rideId', state.rideId); LS.set('rideStartedAt', state.rideStartedAt);
        state.stoppedInfo = null;
        initMap();
        return startWatcher();
      }
      if (state.rideId) {
        state.stoppedInfo = { stoppedAt: data.stoppedAt, reason: data.reason, kind: data.kind };
      }
      state.rideId = null;
      LS.del('rideId');
      state.personalFrom = null; LS.del('personalFrom');
      return stopWatcher();
    }).catch(function () {})
      .then(render);
  }

  function togglePersonal() {
    if (!riding()) return;
    if (!state.personalFrom) {
      state.personalFrom = Date.now();
      LS.set('personalFrom', state.personalFrom);
      render();
      return;
    }
    var from = state.personalFrom, to = Date.now();
    state.personalFrom = null; LS.del('personalFrom');
    render();
    if (HAS_SERVER && state.rideId) {
      apiFetch('/driver/rides/' + state.rideId + '/declare', {
        method: 'POST', body: { kind: 'personal', fromTs: from, toTs: to },
      }).catch(function () {});
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function fmtDur(ms) {
    var m = Math.floor(ms / 60000);
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function statusOf() {
    if (!riding()) return { cls: '', title: 'Not tracking', sub: 'Press Start Ride when you leave.' };
    if (state.permission === 'denied') {
      return { cls: 'bad', title: 'Location is blocked', sub: 'Allow location for this app in Android settings, then start again.' };
    }
    if (!state.watcherId) return { cls: 'warn', title: 'Starting…', sub: 'Waiting for the phone to allow location.' };
    if (!state.lastFixAt) return { cls: 'warn', title: 'Waiting for GPS', sub: 'This can take a minute indoors.' };
    var age = (Date.now() - state.lastFixAt) / 1000;
    if (age > 300) return { cls: 'warn', title: 'Weak signal', sub: 'No new position for ' + Math.round(age / 60) + ' minutes.' };
    if (!HAS_SERVER) return { cls: 'on', title: 'Recording', sub: 'Saved on this phone. Not sent to the office yet.' };
    if (!navigator.onLine && state.queued) return { cls: 'on', title: 'Recording — offline', sub: state.queued + ' positions saved. They send when the network returns.' };
    return { cls: 'on', title: 'Tracking is on', sub: 'Your ride is being recorded.' };
  }

  function render() {
    var named = !!state.name;
    show($('screenName'), !named);
    show($('screenMain'), named);
    if (!named) return;

    text('hName', state.driver && state.driver.name ? state.driver.name : state.name);
    text('hCode', state.driver && state.driver.driverCode ? state.driver.driverCode : 'Modern Drivers');

    var s = statusOf();
    $('status').className = 'status ' + s.cls;
    text('stTitle', s.title);
    text('stSub', s.sub);

    show($('btnStart'), !riding());
    $('btnStart').disabled = state.starting;
    $('btnStart').textContent = state.starting ? 'Starting…' : 'Start Ride';
    show($('rideBtns'), riding());
    show($('statsBox'), riding());
    show($('map'), riding());
    show($('mapEmpty'), !riding());

    text('stKm', (state.distanceM / 1000).toFixed(1));
    text('stTime', state.rideStartedAt ? fmtDur(Date.now() - state.rideStartedAt) : '0m');
    text('stPts', String(state.pointCount));

    var err = $('startErr');
    err.hidden = !state.startError;
    err.textContent = state.startError || '';

    var pb = $('btnPersonal');
    if (state.personalFrom) { pb.className = 'on'; pb.textContent = 'End personal trip'; }
    else { pb.className = ''; pb.textContent = 'Personal trip'; }

    var n = $('notice');
    if (state.stoppedInfo && !riding()) {
      n.className = 'msg info';
      n.innerHTML = '<b>The office stopped your ride.</b> '
        + esc(state.stoppedInfo.kind === 'timeout'
          ? 'It was closed automatically after running a long time.'
          : (state.stoppedInfo.reason || ''));
      n.hidden = false;
    } else if (!HAS_SERVER) {
      n.className = 'msg warn';
      n.innerHTML = '<b>Not connected to the office.</b> Your route is recorded and kept on this phone. '
        + 'Once the office system is switched on, this app will send everything it has saved.';
      n.hidden = false;
    } else n.hidden = true;

    text('footNote', riding() ? 'Only the office can stop a ride.' : 'Only the office can stop a ride.');
  }

  // ── info sheet ─────────────────────────────────────────────────────────
  function noticeHtml() {
    var pts = (state.notice && state.notice.points) || [
      'Your location is recorded only while a ride is running — from when you press Start Ride until the office stops it.',
      'It is used to work out the kilometres you travel for Modern Dairy deliveries.',
      'It is not recorded before you start, and not after the office stops it.',
      'Only Modern Dairy office staff can see it.',
      'Android shows a permanent notification the whole time it is on.',
      'You can mark part of your day as a personal trip. Those kilometres are kept out of Modern Dairy business distance.',
      'Only the office can stop a ride. If you need it stopped, call the office.',
    ];
    return '<ul>' + pts.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>';
  }
  function openSheet() {
    $('sheetTitle').textContent = (state.notice && state.notice.title) || 'How this app uses your location';
    $('sheetBody').innerHTML = noticeHtml();
    $('sheetBg').classList.add('on');
  }

  // ── boot ───────────────────────────────────────────────────────────────
  (function branding() {
    var t = (BRAND.theme) || {};
    var r = document.documentElement.style;
    if (t.brand) r.setProperty('--navy', t.brand);
    if (t.brandDark) r.setProperty('--navy-deep', t.brandDark);
    if (BRAND.appName) { document.title = BRAND.appName; text('introTitle', BRAND.appName); }
    if (BRAND.logo) {
      var l = $('introLogo'); if (l) l.src = BRAND.logo;
      document.querySelectorAll('header img').forEach(function (i) { i.src = BRAND.logo; });
    }
  })();

  $('btnName').addEventListener('click', saveName);
  $('inName').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveName(); });
  $('btnStart').addEventListener('click', startRide);
  $('btnPersonal').addEventListener('click', togglePersonal);
  $('btnCentre').addEventListener('click', function () { followMap = true; drawRoute(); });
  $('btnWhy').addEventListener('click', openSheet);
  $('btnWhy2').addEventListener('click', openSheet);
  $('sheetClose').addEventListener('click', function () { $('sheetBg').classList.remove('on'); });
  $('sheetBg').addEventListener('click', function (e) { if (e.target === $('sheetBg')) $('sheetBg').classList.remove('on'); });
  window.addEventListener('online', function () { sync(); render(); });
  window.addEventListener('offline', render);

  function resume() {
    queue.count().then(function (n) { state.queued = n; render(); });
    if (HAS_SERVER) { checkRide(); sync(); }
    else if (state.localRide) { initMap(); startWatcher(); }
  }
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', function (s) { if (s.isActive) resume(); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resume(); });

  render();
  if (state.name) resume();

  if (HAS_SERVER) {
    setInterval(sync, (CFG.SYNC_INTERVAL_SEC || 45) * 1000);
    setInterval(checkRide, (CFG.RIDE_POLL_SEC || 60) * 1000);
  }
  setInterval(render, 5000);

  window.ModernDrivers = {
    state: state,
    diagnostics: function () {
      return {
        deviceId: state.deviceId, name: state.name, rideId: state.rideId,
        localRide: !!state.localRide, hasServer: HAS_SERVER,
        km: (state.distanceM / 1000).toFixed(2), points: state.pointCount,
        queued: state.queued, watcher: !!state.watcherId, permission: state.permission,
      };
    },
  };
})();
