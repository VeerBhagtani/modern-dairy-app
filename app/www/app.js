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
    notice: LS.get('notice', null),
    tracking: { sampleIntervalSec: CFG.SAMPLE_INTERVAL_SEC || 30, maxBatchPoints: CFG.MAX_BATCH_POINTS || 200 },
    watcherId: null,
    lastFix: null,
    lastFixAt: null,
    lastAccuracyM: null,
    lastHeading: null,
    distanceM: LS.get('distanceM', 0),
    pointCount: LS.get('pointCount', 0),
    queued: 0,
    lastSyncAt: LS.get('lastSyncAt', null),
    permission: 'unknown',
    starting: false,
    startError: null,
    // The plugin's own error text, kept verbatim for Diagnostics. The driver is
    // shown the plain meaning; this is what the office reads out.
    lastPluginError: null,
    // Whether recording will survive the screen locking. False means the
    // driver has foreground permission only, which still records while the app
    // is open — worth saying, not worth blocking over.
    backgroundTracking: false,
    // true/false once the phone has answered; null while unknown, which is also
    // the permanent answer on a build without the battery plugin.
    batteryExempt: null,
    phoneMaker: null,
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
  // Google Maps when the office has saved a browser key (the server hands it
  // out at /driver/maps-config), MapLibre with the free OpenFreeMap tiles
  // otherwise — and whenever Google cannot be reached or refuses the key, so
  // the driver is never left looking at a grey box. The key is remembered on
  // the phone, so the map comes up the same way on the next start even before
  // the server answers.
  var map = null, marker = null, markerArrow = null, mapReady = false, followMap = true, mapShown = false;
  var gmap = null;            // { map, casing, route, start, acc, dot, arrow } when Google is in use
  var mapStarting = false;

  function mapsConfig() {
    var cached = LS.get('mapsCfg', null);
    var fresh = !HAS_SERVER || !(state.tokens && state.tokens.accessToken)
      ? Promise.resolve(null)
      : apiFetch('/driver/maps-config').then(function (c) {
        // A key Google refused on this phone is not tried again at once…
        // …for half an hour, so fixing the key in the Google console is picked up.
        if (cached && cached.refusedKey && c && c.key === cached.refusedKey && Date.now() - (cached.refusedAt || 0) < 30 * 60 * 1000) return cached;
        LS.set('mapsCfg', c);
        return c;
      }).catch(function () { return null; });
    // A remembered answer is used at once; the fresh one takes effect next start.
    if (cached) return Promise.resolve(cached);
    return Promise.race([fresh, new Promise(function (res) { setTimeout(function () { res(null); }, 4000); })]);
  }

  function loadGoogle(key) {
    return new Promise(function (resolve, reject) {
      if (window.google && google.maps && google.maps.Map) { resolve(); return; }
      window.gm_authFailure = function () {
        // Refused key: forget it and fall back to the free map now.
        LS.set('mapsCfg', { provider: 'free', refusedKey: key, refusedAt: Date.now() });
        if (gmap) { gmap = null; var el = $('map'); if (el) el.innerHTML = ''; initFreeMap(); }
      };
      window.__mdGoogleMapsLoaded = function () {
        google.maps.importLibrary('maps').then(function () { resolve(); }, reject);
      };
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key)
        + '&v=weekly&loading=async&region=IN&language=en&callback=__mdGoogleMapsLoaded';
      s.async = true;
      s.onerror = function () { reject(new Error('Google Maps unreachable')); };
      document.head.appendChild(s);
      setTimeout(function () { reject(new Error('Google Maps timed out')); }, 12000);
    });
  }

  function initMap() {
    if (map || gmap || mapStarting) return;
    mapStarting = true;
    mapsConfig().then(function (cfg) {
      if (!(cfg && cfg.provider === 'google' && cfg.key)) return false;
      return loadGoogle(cfg.key).then(function () { initGoogleMap(); return true; });
    }).catch(function () { return false; }).then(function (google_) {
      mapStarting = false;
      if (!google_) initFreeMap();
    });
  }

  function initGoogleMap() {
    var el = $('map');
    if (!el || gmap) return;
    var c = state.lastFix ? { lat: state.lastFix.lat, lng: state.lastFix.lng } : { lat: (CFG.MAP_CENTER || [73.8567, 18.5204])[1], lng: (CFG.MAP_CENTER || [73.8567, 18.5204])[0] };
    var m = new google.maps.Map(el, {
      center: c, zoom: 16, disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy',
    });
    gmap = {
      map: m,
      acc: new google.maps.Circle({ map: m, strokeColor: '#1B2A6B', strokeOpacity: 0.25, strokeWeight: 1, fillColor: '#1B2A6B', fillOpacity: 0.1, clickable: false, visible: false, center: c, radius: 1 }),
      casing: new google.maps.Polyline({ map: m, strokeColor: '#fff', strokeOpacity: 0.9, strokeWeight: 8, clickable: false, zIndex: 1 }),
      route: new google.maps.Polyline({ map: m, strokeColor: '#1B2A6B', strokeOpacity: 1, strokeWeight: 4.5, clickable: false, zIndex: 2 }),
      start: new google.maps.Marker({ map: null, clickable: false, zIndex: 5,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#fff', fillOpacity: 1, strokeColor: '#1a7a4c', strokeWeight: 3 } }),
      dot: new google.maps.Marker({ map: null, clickable: false, zIndex: 10,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#1B2A6B', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } }),
      arrow: new google.maps.Marker({ map: null, clickable: false, zIndex: 11 }),
    };
    m.addListener('dragstart', function () { followMap = false; });
    mapReady = true;
    drawRoute();
  }

  function mapCenter(lng, lat) {
    if (gmap) gmap.map.setCenter({ lat: lat, lng: lng });
    else if (map) map.setCenter([lng, lat]);
  }
  function mapResize() {
    if (map) map.resize();
    // A Google map re-measures itself when its container changes size.
    drawRoute();
  }

  function initFreeMap() {
    if (map || !window.maplibregl) return;
    try { if (maplibregl.setWorkerUrl) maplibregl.setWorkerUrl('vendor/maplibre/maplibre-gl-csp-worker.js'); } catch (e) {}
    try {
      map = new maplibregl.Map({
        container: 'map',
        style: CFG.MAP_STYLE || 'https://tiles.openfreemap.org/styles/liberty',
        center: state.lastFix ? [state.lastFix.lng, state.lastFix.lat] : (CFG.MAP_CENTER || [73.8567, 18.5204]),
        zoom: 16,
        attributionControl: { compact: true },
      });
      map.on('load', function () {
        mapReady = true;

        // The accuracy circle, drawn underneath everything: an honest picture
        // of how well the phone actually knows where it is, rather than a dot
        // that implies more precision than GPS has.
        map.addSource('acc', { type: 'geojson', data: emptyFC() });
        map.addLayer({
          id: 'acc-fill', type: 'fill', source: 'acc',
          paint: { 'fill-color': '#1B2A6B', 'fill-opacity': 0.1 },
        });
        map.addLayer({
          id: 'acc-line', type: 'line', source: 'acc',
          paint: { 'line-color': '#1B2A6B', 'line-opacity': 0.25, 'line-width': 1 },
        });

        map.addSource('route', { type: 'geojson', data: lineFC(state.route) });
        map.addLayer({
          id: 'route-casing', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#fff', 'line-width': 8, 'line-opacity': .9 },
        });
        map.addLayer({
          id: 'route-line', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#1B2A6B', 'line-width': 4.5 },
        });

        // Where the ride began, so the driver can see the shape of the day.
        map.addSource('startpin', { type: 'geojson', data: emptyFC() });
        map.addLayer({
          id: 'startpin-dot', type: 'circle', source: 'startpin',
          paint: {
            'circle-radius': 6, 'circle-color': '#fff',
            'circle-stroke-width': 3, 'circle-stroke-color': '#1a7a4c',
          },
        });

        drawRoute();
      });
      // Panning turns following off, so the driver can look ahead without the
      // map yanking back every thirty seconds. "Centre map" turns it back on.
      map.on('dragstart', function () { followMap = false; });
    } catch (e) { map = null; }
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
  function lineFC(coords) {
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords || [] }, properties: {} };
  }

  // A circle on the ground, in metres, as a polygon — MapLibre has no
  // metre-radius circle, and a pixel radius would lie at every other zoom.
  function accuracyCircle(centre, radiusM) {
    var pts = [], n = 48;
    var dLat = radiusM / 111320;
    var dLng = radiusM / (111320 * Math.cos(centre[1] * Math.PI / 180) || 1);
    for (var i = 0; i <= n; i += 1) {
      var a = (i / n) * 2 * Math.PI;
      pts.push([centre[0] + dLng * Math.cos(a), centre[1] + dLat * Math.sin(a)]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  }

  // The driver's own marker: a filled disc with a white ring and a heading
  // arrow, the shape people already read as "you are here" from every other
  // map they use. It rotates to the direction of travel when the phone reports
  // one and hides the arrow when it does not, rather than pointing north and
  // pretending.
  function buildMarkerEl() {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'width:42px;height:42px;position:relative;';
    wrap.innerHTML = ''
      + '<div class="md-pulse" style="position:absolute;inset:0;border-radius:50%;'
      + 'background:rgba(27,42,107,.18);"></div>'
      + '<div style="position:absolute;left:50%;top:50%;width:20px;height:20px;margin:-10px 0 0 -10px;'
      + 'border-radius:50%;background:#1B2A6B;border:3px solid #fff;'
      + 'box-shadow:0 1px 6px rgba(0,0,0,.45);"></div>'
      + '<svg class="md-arrow" width="42" height="42" viewBox="0 0 42 42" '
      + 'style="position:absolute;inset:0;display:none;">'
      + '<path d="M21 2 L26 12 L21 9.5 L16 12 Z" fill="#1B2A6B" stroke="#fff" stroke-width="1.4"'
      + ' stroke-linejoin="round"/></svg>';
    return wrap;
  }

  function drawRoute() {
    if (gmap) { drawRouteGoogle(); return; }
    if (!map || !mapReady) return;
    // Before a ride there is no route, but there is a position — the marker
    // follows the latest fix either way, so the driver sees themself on the map
    // the moment the app opens.
    var last = state.route[state.route.length - 1]
      || (state.lastFix ? [state.lastFix.lng, state.lastFix.lat] : null);

    var routeSrc = map.getSource('route');
    if (routeSrc) routeSrc.setData(lineFC(state.route));

    var startSrc = map.getSource('startpin');
    if (startSrc) {
      startSrc.setData(state.route.length > 1
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: state.route[0] }, properties: {} }] }
        : emptyFC());
    }

    if (!last) return;

    var accSrc = map.getSource('acc');
    if (accSrc) {
      var r = state.lastAccuracyM;
      accSrc.setData(r && r > 5 && r < 500
        ? { type: 'FeatureCollection', features: [accuracyCircle(last, r)] }
        : emptyFC());
    }

    if (!marker) {
      var el = buildMarkerEl();
      markerArrow = el.querySelector('.md-arrow');
      marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(last).addTo(map);
    } else {
      marker.setLngLat(last);
    }
    if (markerArrow) {
      if (state.lastHeading == null) markerArrow.style.display = 'none';
      else {
        markerArrow.style.display = '';
        marker.setRotation(state.lastHeading);
      }
    }

    if (followMap) map.easeTo({ center: last, duration: 700 });
  }

  // The same picture on Google Maps: route with a white casing, start dot,
  // accuracy circle, the driver's disc and, when the phone knows it, an arrow
  // for the direction of travel.
  function drawRouteGoogle() {
    var g = gmap;
    var ll = function (c) { return { lat: c[1], lng: c[0] }; };
    var path = state.route.map(ll);
    g.casing.setPath(path);
    g.route.setPath(path);
    if (state.route.length > 1) { g.start.setPosition(path[0]); g.start.setMap(g.map); } else g.start.setMap(null);
    var lastC = state.route[state.route.length - 1] || (state.lastFix ? [state.lastFix.lng, state.lastFix.lat] : null);
    if (!lastC) return;
    var last = ll(lastC);
    var r = state.lastAccuracyM;
    if (r && r > 5 && r < 500) { g.acc.setCenter(last); g.acc.setRadius(r); g.acc.setVisible(true); } else g.acc.setVisible(false);
    g.dot.setPosition(last); g.dot.setMap(g.map);
    if (state.lastHeading == null) g.arrow.setMap(null);
    else {
      // A small arrowhead just ahead of the disc, turned about the position.
      g.arrow.setIcon({ path: 'M 0,-4.4 L 1.1,-2.6 L 0,-3.1 L -1.1,-2.6 Z', scale: 5, rotation: state.lastHeading,
        fillColor: '#1B2A6B', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.4 });
      g.arrow.setPosition(last); g.arrow.setMap(g.map);
    }
    if (followMap) g.map.panTo(last);
  }

  // ── location on open ───────────────────────────────────────────────────
  // The app asks for location the moment it opens. Two reasons: the Android
  // dialog is dealt with in the office rather than at the wheel, and the driver
  // sees themself on the map before pressing anything.
  //
  // This uses the plain Geolocation plugin, not the background one. That
  // matters: the background plugin would also start the foreground service and
  // begin recording, and nothing may be recorded outside a ride. Here a single
  // fix is read to draw the map with, and it is never queued — onLocation's
  // `if (!riding())` guard is what keeps that true for the watcher too.
  var GEO = null;
  function geoPlugin() {
    if (!GEO && window.Capacitor && window.Capacitor.registerPlugin) {
      GEO = window.Capacitor.registerPlugin('Geolocation');
    }
    return GEO;
  }

  function readOneFix() {
    var p = geoPlugin();
    if (p) {
      return p.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 })
        .then(function (pos) {
          return { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        });
    }
    // Plain browser, for testing the page outside the app.
    if (!navigator.geolocation) return Promise.reject(new Error('no geolocation'));
    return new Promise(function (res, rej) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        res({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy });
      }, rej, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
    });
  }

  var primed = false;
  function primeLocation() {
    if (primed) return Promise.resolve();
    primed = true;
    return ensureLocationPermission().then(function (perm) {
      // The plugin refuses to even ask while the phone's location switch is
      // off. That used to be swallowed here, and the driver was told to "move
      // somewhere with a clear view of the sky" — advice for a different fault.
      if (perm === 'device-off') {
        state.permission = 'device-off';
        primed = false;
        text('mapEmptyText', 'The phone\'s location is off. Turn Location on in quick settings.');
        render();
        return null;
      }
      if (perm === 'denied') {
        state.permission = 'denied';
        // Not latched: the driver may go and allow it in Settings, and coming
        // back must look again rather than assume the answer from a minute ago.
        primed = false;
        text('mapEmptyText', 'Location is blocked. Allow location for this app in Android settings.');
        render();
        return null;
      }
      return readOneFix().then(function (f) {
        state.permission = 'granted';
        state.lastFix = { lat: f.lat, lng: f.lng };
        state.lastFixAt = Date.now();
        state.lastAccuracyM = f.acc == null ? null : f.acc;
        render();                       // shows the map container first…
        initMap();                      // …so MapLibre measures a real height
        mapCenter(f.lng, f.lat);
        drawRoute();
      });
    }).catch(function () {
      // No fix is not the same as no permission, and it is usually temporary —
      // a basement, a first cold start. Retry on the next resume.
      primed = false;
      text('mapEmptyText', 'Could not get a position yet. Move somewhere with a clear view of the sky.');
      render();
    });
  }

  // ── tracking ───────────────────────────────────────────────────────────
  var BG = null;
  function bg() {
    if (!BG && window.Capacitor && window.Capacitor.registerPlugin) {
      BG = window.Capacitor.registerPlugin('BackgroundGeolocation');
    }
    return BG;
  }

  /* Why tracking cannot start, in words that point at the fix.
   *
   * There used to be one message here — "Location is not available in this
   * build" — for three unrelated failures: the page running outside the app at
   * all, the plugin missing from the APK, and Android refusing the permission.
   * A driver cannot act on that, and neither can whoever they ring. Each cause
   * now names itself.
   */
  function locationTrouble() {
    // Two different faults, which this used to report as one. Android's bridge
    // defines window.Capacitor; registerPlugin comes from capacitor.js, which
    // the app loads itself. Bridge present without registerPlugin means the
    // APK was built without that file — the app IS the app, and telling the
    // driver to "open the app instead of a browser" was false.
    if (!window.Capacitor) {
      // "; wv)" is how Android's WebView marks itself in the user agent, so
      // this page IS inside the app and Android failed to hand it the bridge.
      // The usual cause is an outdated "Android System WebView", which is
      // updated from the Play Store like any app.
      if (/; wv\)/.test(navigator.userAgent || '')) {
        return 'The app could not connect to the phone\'s location service. Open the Play Store, '
          + 'search "Android System WebView", tap Update, then reopen this app.';
      }
      return 'This page is not running inside the Modern Drivers app, so it cannot use GPS. '
        + 'Open the app from the phone\'s home screen rather than a browser tab.';
    }
    if (!window.Capacitor.registerPlugin) {
      return 'This copy of the app is missing part of itself and cannot reach GPS. '
        + 'The office needs to send a new APK.';
    }
    if (!bg()) return 'The location service is missing from this build. The office needs a new APK.';
    return null;
  }

  // ── battery optimisation ───────────────────────────────────────────────
  //
  // The most common reason a ride stops recording on a phone in India. Xiaomi,
  // Realme, Vivo, Oppo and Samsung all close background apps to save battery,
  // and a foreground service with its notification showing is not enough to
  // stop them. The exemption is one system dialog, and only the driver can
  // answer it. BatteryOptimisation is this app's own small native plugin
  // (app/native/android); on a build without it every call here is a no-op.
  var BAT = null;
  function batteryPlugin() {
    if (!BAT && window.Capacitor && window.Capacitor.registerPlugin) {
      BAT = window.Capacitor.registerPlugin('BatteryOptimisation');
    }
    return BAT;
  }

  /* Refresh state.batteryExempt; with askIfNeeded, show Android's own dialog
   * the first time a ride starts on a restricted phone. Once only, on its own:
   * after that the status line and the button offer it, so a driver who said
   * no is not asked every morning. */
  function checkBattery(askIfNeeded) {
    var p = batteryPlugin();
    if (!p || typeof p.status !== 'function') return Promise.resolve(null);
    return p.status().then(function (r) {
      state.batteryExempt = !!(r && r.exempt);
      state.phoneMaker = (r && r.manufacturer) || null;
      render();
      if (!state.batteryExempt && askIfNeeded && !LS.get('askedBattery', false)) {
        LS.set('askedBattery', true);
        return p.requestExemption().catch(function () { return null; });
      }
      return null;
    }).catch(function () { state.batteryExempt = null; return null; });
  }

  // Phone makers that add their own app-killing on top of Android's, with the
  // name of the extra switch. Android's exemption does not reach these; the
  // driver has to find them, so the app names them.
  var MAKER_STEPS = {
    xiaomi: 'Settings → Apps → Modern Drivers → turn on Autostart, and set Battery saver to "No restrictions".',
    redmi: 'Settings → Apps → Modern Drivers → turn on Autostart, and set Battery saver to "No restrictions".',
    poco: 'Settings → Apps → Modern Drivers → turn on Autostart, and set Battery saver to "No restrictions".',
    realme: 'Settings → Apps → Modern Drivers → Battery usage → allow background activity and Auto launch.',
    oppo: 'Settings → Apps → Modern Drivers → Battery usage → allow background activity and Auto launch.',
    oneplus: 'Settings → Apps → Modern Drivers → Battery → choose "Unrestricted".',
    vivo: 'Settings → Battery → Background power consumption → Modern Drivers → Allow.',
    iqoo: 'Settings → Battery → Background power consumption → Modern Drivers → Allow.',
    samsung: 'Settings → Apps → Modern Drivers → Battery → choose "Unrestricted".',
  };

  function showBatterySteps() {
    var maker = String(state.phoneMaker || '').toLowerCase();
    var extra = MAKER_STEPS[maker];
    $('sheetTitle').textContent = 'Keep recording with the screen off';
    $('sheetBody').innerHTML = '<p class="note" style="text-align:left;margin:0 0 10px">'
      + 'This phone is set to close apps in the background to save battery. That stops '
      + 'your ride from being recorded once the screen locks.</p>'
      + '<p style="margin:0 0 10px"><button id="btnBatAsk" class="plan" style="width:100%">'
      + 'Allow Modern Drivers to run in the background</button></p>'
      + (extra
        ? '<p class="note" style="text-align:left;margin:0">Also, on this ' + esc(state.phoneMaker) + ' phone: '
          + esc(extra) + '</p>'
        : '');
    $('sheetBg').classList.add('on');
    var b = $('btnBatAsk');
    if (b) {
      b.addEventListener('click', function () {
        var p = batteryPlugin();
        if (p && typeof p.requestExemption === 'function') p.requestExemption().catch(function () {});
      });
    }
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
    // This is where the plugin reports refusals — not on addWatcher's promise.
    if (error) {
      watcherFailed(error.message || String(error), error.code);
      return;
    }
    if (!location) return;
    // A fix arriving is the only proof that permission is actually held, so it
    // is what clears a previous refusal rather than anything the app asserts.
    state.permission = 'granted';
    state.startError = null;
    state.lastFix = { lat: location.latitude, lng: location.longitude };
    state.lastFixAt = Date.now();
    state.lastAccuracyM = location.accuracy == null ? null : location.accuracy;
    // Android reports bearing only while genuinely moving; when it does not,
    // the arrow is hidden rather than left pointing at a stale direction.
    state.lastHeading = (location.bearing == null || location.speed === 0) ? null : location.bearing;
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
      // The ride this fix belongs to, kept with it in the queue. Without it a
      // fix waiting to be sent when the office stopped the ride had no home:
      // it was later sent to whichever ride was current, and yesterday's
      // travel landed in today's kilometres.
      rideId: state.rideId || null,
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

  /* Starting the recorder.
   *
   * The thing three earlier fixes all got wrong, so it is written down here:
   * addWatcher is a CALLBACK method, not a promise method. Capacitor declares
   * it RETURN_CALLBACK, so the promise resolves with a callback-id string the
   * instant the message is posted to Android and can never reject. Everything
   * the plugin refuses — a denied permission, the phone's location switch off,
   * the service not yet bound — comes back as the SECOND ARGUMENT of the
   * callback, in onLocation, and never as a rejection.
   *
   * A .catch() here therefore cannot fire for any of the failures that matter,
   * and the id is stored even when the watcher is already dead. Since this
   * function returns early whenever an id is stored, one failure used to wedge
   * recording for the rest of the session: the driver switched location on,
   * came back, and nothing tried again.
   *
   * So: failures are handled in watcherFailed, reached from the callback, and
   * every failure clears the id so the next attempt is a real attempt.
   *
   * backgroundMessage is always set. It is what makes the plugin run a
   * foreground service, and the foreground service — not the background
   * permission — is what keeps fixes arriving once the screen locks. The plugin
   * never asks for ACCESS_BACKGROUND_LOCATION at all (its permission alias is
   * fine + coarse only), and it does not need to: that permission governs
   * STARTING location from the background, which this app never does.
   */
  /* Hold the permission BEFORE the recorder starts, never during.
   *
   * The background plugin will ask for permission itself, but it does not wait
   * for the answer: it carries on and starts its service at once. Without the
   * permission yet, Android refuses to make that service a foreground service,
   * the plugin swallows the error, and when the driver then taps Allow only the
   * GPS is restarted — not the foreground service. The ride looks fine while
   * the app is open and stops recording the moment the screen locks.
   *
   * So the question is asked here first, through the plain Geolocation plugin,
   * which does wait. It also says plainly when the phone's location switch is
   * off ("Location services are not enabled"), which is the one answer the
   * driver most needs to hear and the background plugin words ambiguously.
   *
   * Resolves 'granted', 'denied', 'device-off', or 'unknown' — the last meaning
   * the question could not be put, and the recorder should try and report.
   */
  function ensureLocationPermission() {
    var p = geoPlugin();
    if (!p || typeof p.requestPermissions !== 'function') return Promise.resolve('unknown');
    // After the driver has refused, only LOOK — checkPermissions never shows a
    // dialog. This runs on every return to the app and every minute from
    // checkRide, and Android's permission dialog is itself something the app
    // returns from, so asking here would put the dialog straight back in front
    // of a driver who just tapped Deny, again and again. Pressing Start Ride
    // clears the refusal, so the driver's own tap still asks properly.
    var lookOnly = state.permission === 'denied' && typeof p.checkPermissions === 'function';
    var q = lookOnly ? p.checkPermissions() : p.requestPermissions({ permissions: ['location'] });
    return q.then(function (r) {
      if (!r) return 'unknown';
      return r.location === 'granted' ? 'granted' : 'denied';
    }, function (e) {
      return /not enabled|disabled/i.test((e && e.message) || '') ? 'device-off' : 'unknown';
    });
  }


  var startingWatcher = false;
  function startWatcher() {
    var trouble = locationTrouble();
    if (trouble) { state.startError = trouble; render(); return Promise.resolve(); }
    if (state.watcherId || startingWatcher) return Promise.resolve();
    startingWatcher = true;

    return ensureLocationPermission().then(function (perm) {
      if (perm === 'device-off' || perm === 'denied') {
        startingWatcher = false;
        watcherFailed(perm === 'device-off' ? 'Location services disabled.' : 'User denied location permission',
          'NOT_AUTHORIZED');
        return null;
      }
      return addRecorder();
    });
  }

  function addRecorder() {
    var opts = {
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
      // The wording is deliberate: the driver should never be unsure whether
      // they are being recorded.
      backgroundTitle: 'Modern Drivers — ride in progress',
      backgroundMessage: 'Your route is being recorded.',
    };

    return bg().addWatcher(opts, onLocation).then(function (id) {
      startingWatcher = false;
      state.watcherId = id;
      state.backgroundTracking = true;
      state.startError = null;
      render();
      // Asked here, once the recorder is known to be running, because this is
      // the moment the answer starts to matter.
      checkBattery(true).then(reportHealth);
    }).catch(function (e) {
      // Reached only if the bridge itself fails, which means the plugin is not
      // in this build. The plugin's own refusals arrive through onLocation.
      startingWatcher = false;
      watcherFailed((e && e.message) || String(e || ''), e && e.code);
    });
  }

  /* Every way the recorder can fail, in words a driver can act on.
   *
   * The plugin has three refusals and they need three different answers:
   *   "Location services disabled."      NOT_AUTHORIZED — the PHONE's switch
   *   "User denied location permission"  NOT_AUTHORIZED — THIS APP's permission
   *   "Service not running."                            — bound too early
   *
   * The first two share a code and have opposite remedies, so matching on the
   * code alone tells the driver to fix the wrong thing. That is worth the extra
   * branch: "turn the phone's location on" to somebody whose location is
   * already on is how an app loses its user.
   */
  function watcherFailed(raw, code) {
    raw = String(raw || '');
    state.lastPluginError = (code ? code + ': ' : '') + raw;

    // The plugin released the saved call when it refused, so no fix will ever
    // reach this callback again. Drop the id, or startWatcher will decline to
    // try for the rest of the session.
    var dead = state.watcherId;
    state.watcherId = null;
    state.backgroundTracking = false;
    if (dead) { try { bg().removeWatcher({ id: dead }).catch(function () {}); } catch (e) { /* already gone */ } }

    var offSwitch = /services? disabled/i.test(raw);
    var notReady = /service not running/i.test(raw);
    var refused = !offSwitch && /denied|permission|NOT_AUTHORIZED/i.test(raw + ' ' + (code || ''));

    if (offSwitch) {
      state.permission = 'device-off';
      state.startError = 'The phone\'s own location switch is off. Swipe down from the top of the '
        + 'screen, turn Location on, then come back — recording starts by itself.';
    } else if (refused) {
      state.permission = 'denied';
      state.startError = 'This app is not allowed to use precise location. Tap "Fix permission" below, '
        + 'open Location, choose "Allow all the time", and turn on "Use precise location".';
    } else if (notReady) {
      // The plugin binds its service asynchronously when the app loads; asking
      // too soon after opening is a race, not a fault. Say nothing and retry.
      state.startError = null;
      setTimeout(function () { if (riding()) startWatcher(); }, CFG.WATCHER_RETRY_MS || 1500);
    } else if (/not implemented|unimplemented|no such|does not have/i.test(raw)) {
      state.startError = 'The location service is missing from this build. The office needs a new APK.';
    } else {
      state.startError = 'Could not start location: ' + raw;
    }
    render();
    // Not for the start-up race: that retries every second or two, and each
    // report is a write the server rate-limits.
    if (!notReady) reportHealth();
  }

  function stopWatcher() {
    var p = bg();
    if (!p || !state.watcherId) return Promise.resolve();
    var id = state.watcherId;
    state.watcherId = null;
    state.backgroundTracking = false;
    return p.removeWatcher({ id: id }).catch(function () {});
  }

  // ── sync ───────────────────────────────────────────────────────────────
  var syncing = false;
  /* Send queued fixes, each to the ride it was recorded in.
   *
   * A batch can hold fixes from two rides — the end of one the office stopped
   * while the phone was offline, and the start of the next — so it is split by
   * ride and each part goes to its own ride. The server accepts a stopped
   * ride's fixes up to its stop time and names anything else as rejected, and
   * a fix is deleted from the queue only once the server has accounted for it
   * by id, either way. Fixes from before this change carry no ride and go to
   * the current one; the server refuses any that predate it.
   */
  function sync() {
    if (!HAS_SERVER || syncing || !state.tokens) return Promise.resolve();
    syncing = true;
    var anyStopped = false;
    return queue.take(state.tracking.maxBatchPoints).then(function (pts) {
      var groups = {};
      var order = [];
      pts.forEach(function (p) {
        var ride = p.rideId || state.rideId;
        if (!ride) return;              // recorded with no ride and none now: wait
        if (!groups[ride]) { groups[ride] = []; order.push(ride); }
        var copy = {};
        Object.keys(p).forEach(function (k) { if (k !== 'rideId') copy[k] = p[k]; });
        groups[ride].push(copy);
      });
      // One ride after another, so the order of the day's fixes is kept.
      return order.reduce(function (chain, ride) {
        return chain.then(function () {
          return apiFetch('/driver/rides/' + ride + '/points', { method: 'POST', body: { points: groups[ride] } })
            .then(function (data) {
              // Delete only what the server confirmed, plus anything it
              // rejected — retrying those forever would wedge the queue.
              var done = (data.accepted || []).concat((data.rejected || [])
                .map(function (r) { return r.clientPointId; }).filter(Boolean));
              if (data.rideActive === false && ride === state.rideId) anyStopped = true;
              return queue.remove(done).then(function () {
                state.lastSyncAt = Date.now();
                LS.set('lastSyncAt', state.lastSyncAt);
              });
            }, function (e) {
              if (e.code === 'RIDE_STOPPED') { anyStopped = true; return null; }
              // A ride that no longer exists or is not this driver's: nothing
              // can ever accept these fixes, and keeping them wedges the queue.
              if (e.status === 404 || e.status === 403) {
                return queue.remove(groups[ride].map(function (p) { return p.clientPointId; }));
              }
              throw e;
            });
        });
      }, Promise.resolve());
    }).then(function () {
      if (anyStopped) return checkRide();
      return null;
    }).catch(function () {
      return null;  // a dead zone is normal; keep the points and retry later
    }).then(function () { return queue.count(); })
      .then(function (n) { state.queued = n; syncing = false; render(); })
      .catch(function () { syncing = false; });
  }


  /* Tell the office what this phone's location is doing.
   *
   * The server has had an endpoint for this since the beginning and the app has
   * never called it, which meant a driver whose permission was refused looked
   * identical to one parked in a shed: no data either way. Now the office can
   * tell those apart while the driver is still out, instead of the next morning.
   *
   * Fire and forget. A failed health report must never disturb a ride.
   */
  function reportHealth() {
    if (!HAS_SERVER || !state.tokens) return Promise.resolve(null);
    return apiFetch('/driver/health', {
      method: 'POST',
      body: {
        locationPermission: state.permission,
        backgroundPermission: state.backgroundTracking ? 'granted' : 'unknown',
        gpsEnabled: state.permission !== 'device-off',
        // The server's field means "the phone restricts this app", the reverse
        // of exempt; left out while unknown rather than guessed.
        batteryOptimised: state.batteryExempt === null ? undefined : !state.batteryExempt,
        online: navigator.onLine !== false,
        queuedPoints: state.queued,
        appVersion: APP_VERSION,
      },
    }).catch(function () { return null; });
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
      primeLocation();
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
        primeLocation();
      });
  }

  // ── ride ───────────────────────────────────────────────────────────────
  function startRide() {
    if (state.starting) return;
    state.starting = true; state.startError = null;
    // The driver's own tap: ask Android properly again, dialog and all, rather
    // than only looking as the automatic retries do after a refusal.
    if (state.permission === 'denied') state.permission = 'unknown';
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
      return stopWatcher();
    }).catch(function () {})
      .then(render);
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function fmtDur(ms) {
    var m = Math.floor(ms / 60000);
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function statusOf() {
    if (!riding()) return { cls: '', title: 'Not tracking', sub: 'Press Start Ride when you leave.' };
    // Two refusals, two remedies. Telling a driver whose location is already on
    // to turn it on is how the app gets blamed for the phone's setting.
    if (state.permission === 'device-off') {
      return { cls: 'bad', title: 'The phone\'s location is off', sub: 'Turn Location on in the phone\'s quick settings. This restarts by itself.' };
    }
    if (state.permission === 'denied') {
      return { cls: 'bad', title: 'This app is not allowed to use location', sub: 'Tap Fix permission below. The phone\'s location switch is a different setting.' };
    }
    if (!state.watcherId) return { cls: 'warn', title: 'Starting…', sub: 'Waiting for the phone to allow location.' };
    if (!state.lastFixAt) return { cls: 'warn', title: 'Waiting for GPS', sub: 'This can take a minute indoors.' };
    var age = (Date.now() - state.lastFixAt) / 1000;
    if (age > 300) return { cls: 'warn', title: 'Weak signal', sub: 'No new position for ' + Math.round(age / 60) + ' minutes.' };
    // Ahead of the sync states: those are about whether the office has the
    // points yet, this is about whether they will be recorded at all.
    // Recording right now, but the phone will close the app once the screen has
    // been locked a while. Green here would be a promise the phone will break.
    if (state.batteryExempt === false) {
      return {
        cls: 'warn',
        title: 'Recording — battery saver may stop it',
        sub: 'Tap "Keep recording with screen off" below, or the ride stops recording when the screen locks.',
      };
    }
    if (!HAS_SERVER) return { cls: 'on', title: 'Recording', sub: 'Saved on this phone. Not sent to the office yet.' };
    if (!navigator.onLine && state.queued) return { cls: 'on', title: 'Recording — offline', sub: state.queued + ' positions saved. They send when the network returns.' };
    // Recording without background permission is real recording, and the
    // kilometres are real — but it stops when the screen locks, and a driver
    // who is not told that will pocket the phone and lose half a round.
    if (!state.backgroundTracking) {
      return {
        cls: 'warn',
        title: 'Recording — keep the app open',
        sub: 'This phone has not allowed background location, so recording stops if the screen locks.',
      };
    }
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

    // Planning needs the office system: the restaurant list and the driver's
    // own learned distances both live there. Offline, the button would only
    // ever produce an error, so it is not offered.
    show($('btnPlan'), HAS_SERVER && !!state.tokens);
    show($('btnHistory'), HAS_SERVER && !!state.tokens);

    // The map is up as soon as there is anything true to draw on it.
    var wantMap = riding() || !!state.lastFix;
    show($('map'), wantMap);
    show($('mapEmpty'), !wantMap);
    if (wantMap && !mapShown) {
      mapShown = true;
      if (map || gmap) setTimeout(mapResize, 0);
    } else if (!wantMap) {
      mapShown = false;
    }

    text('stKm', (state.distanceM / 1000).toFixed(1));
    text('stTime', state.rideStartedAt ? fmtDur(Date.now() - state.rideStartedAt) : '0m');
    text('stPts', String(state.pointCount));

    var err = $('startErr');
    err.hidden = !state.startError;
    err.textContent = state.startError || '';
    // Offered for both refusals — this app's permission and the phone's own
    // switch — because the button leads somewhere useful for each, and noise
    // against any other error.
    // Then the battery saver, which only matters once location itself works.
    var locFault = state.permission === 'denied' || state.permission === 'device-off';
    var batFault = !locFault && riding() && state.batteryExempt === false;
    show($('btnFixPerm'), locFault || batFault);
    $('btnFixPerm').textContent = state.permission === 'device-off' ? 'How to turn location on'
      : locFault ? 'Fix permission' : 'Keep recording with screen off';

    var n = $('notice');
    if (state.stoppedInfo && !riding()) {
      n.className = 'msg info';
      // A ride ends with its day: every day is kept as its own ride, so the
      // driver's history and the office's reports show one row per day. That
      // is not the office stopping anybody, and it must not read like it.
      n.innerHTML = state.stoppedInfo.kind === 'day_end'
        ? '<b>Yesterday\'s ride has ended.</b> Each day is its own ride. Press Start Ride to begin today.'
        : '<b>The office stopped your ride.</b> '
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
      'Only the office can stop a ride. If you need it stopped, call the office.',
    ];
    return '<ul>' + pts.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>';
  }
  function openSheet() {
    $('sheetTitle').textContent = (state.notice && state.notice.title) || 'How this app uses your location';
    $('sheetBody').innerHTML = noticeHtml()
      + '<p style="margin-top:18px"><button class="link" id="btnDiag" '
      + 'style="background:none;border:none;color:var(--navy);font-weight:600;text-decoration:underline;padding:0">'
      + 'Something is not working</button></p>';
    $('sheetBg').classList.add('on');
    var d = $('btnDiag');
    if (d) d.addEventListener('click', openDiagnostics);
  }

  /* What the office needs to know when a driver says "it does not work".
   *
   * Written for someone reading it down a phone line. Every line is a fact the
   * app can actually check, in plain words, so the answer to "what does it
   * say?" is useful instead of "it says it does not work". Without this the
   * only way to find out why a phone will not track is to have the phone.
   */
  function openDiagnostics() {
    var inApp = !!window.Capacitor;
    var runtime = !!(window.Capacitor && window.Capacitor.registerPlugin);
    var row = function (label, ok, detail) {
      return '<tr><td style="padding:7px 0;vertical-align:top">' + esc(label) + '</td>'
        + '<td style="padding:7px 0 7px 10px;text-align:right;white-space:nowrap;font-weight:600;color:'
        + (ok === null ? 'var(--ink-2)' : ok ? 'var(--ok)' : 'var(--bad)') + '">'
        + esc(detail) + '</td></tr>';
    };

    $('sheetTitle').textContent = 'Diagnostics';
    $('sheetBody').innerHTML = '<p class="note" style="text-align:left;margin:0 0 12px">'
      + 'Read this out to the office.</p>'
      + '<table style="width:100%;font-size:.86rem;border-collapse:collapse">'
      + row('Running inside the app', inApp, inApp ? 'yes' : 'NO — opened in a browser')
      + row('App runtime loaded', runtime, runtime ? 'yes' : 'NO — needs a new APK')
      + row('Location service present', !!bg(), bg() ? 'yes' : 'NO — needs a new APK')
      + row('Phone\'s location switch', state.permission !== 'device-off',
        state.permission === 'device-off' ? 'OFF' : (state.lastFix ? 'on' : 'not known yet'))
      + row('Permission for this app', state.permission === 'granted', state.permission)
      + row('Recorder running', !!state.watcherId, state.watcherId ? 'yes' : 'no')
      + row('Last GPS fix', !!state.lastFix,
        state.lastFix ? fmtDur(Date.now() - (state.lastFixAt || Date.now())) + ' ago' : 'never')
      // The coordinates themselves, because "it says it has a fix" and "the fix
      // is a real place in Pune" are different claims and only one is worth
      // reading out.
      + row('Where it thinks it is', !!state.lastFix,
        state.lastFix ? state.lastFix.lat.toFixed(5) + ', ' + state.lastFix.lng.toFixed(5) : '—')
      + row('Accuracy', state.lastAccuracyM != null && state.lastAccuracyM <= 50,
        state.lastAccuracyM == null ? '—' : Math.round(state.lastAccuracyM) + ' m')
      + row('Office server', HAS_SERVER, HAS_SERVER ? 'configured' : 'NOT set in this build')
      + row('Signed in', !!state.tokens, state.tokens ? 'yes' : 'no')
      + row('Ride running', riding(), riding() ? 'yes' : 'no')
      + row('Records with screen locked', state.backgroundTracking,
        state.backgroundTracking ? 'yes' : 'no — foreground only')
      + row('Battery saver allows it', state.batteryExempt,
        state.batteryExempt === null ? 'not known' : state.batteryExempt ? 'yes' : 'NO — will stop recording')
      + row('Phone', null, state.phoneMaker || '—')
      + row('Points waiting to send', state.queued === 0, String(state.queued))
      + row('Last sent to office', !!state.lastSyncAt,
        state.lastSyncAt ? fmtDur(Date.now() - state.lastSyncAt) + ' ago' : 'never')
      + row('App version', null, APP_VERSION)
      + '</table>'
      + (state.startError
        ? '<p style="margin-top:14px;font-size:.84rem;color:var(--bad)"><b>Last error</b><br>'
          + esc(state.startError) + '</p>'
        : '')
      + (state.lastPluginError
        ? '<p style="margin-top:10px;font-size:.76rem;color:var(--ink-2)"><b>Technical detail</b><br>'
          + esc(state.lastPluginError) + '</p>'
        : '')
      + '<p style="margin-top:16px"><button id="btnSelfTest" class="plan" style="width:100%">'
      + 'Test location now</button></p>'
      + '<div id="selfTest" style="font-size:.84rem;margin-top:10px"></div>';

    var b = $('btnSelfTest');
    if (b) b.addEventListener('click', runSelfTest);
  }

  /* Prove the chain, one link at a time, on the phone that is failing.
   *
   * Reading rows of state tells you what the app believes. This tells you what
   * actually happens right now: the phone is asked for a position, the position
   * is shown, and it is sent to the office and the office's reply is shown. If
   * a link is broken, the test stops at the broken one and names it — which is
   * the question "it does not work" never answers.
   */
  function runSelfTest() {
    var out = $('selfTest');
    if (!out) return;
    var steps = [];
    var paint = function () { out.innerHTML = steps.join(''); };
    var say = function (ok, label, detail) {
      steps.push('<div style="padding:4px 0;color:' + (ok === null ? 'var(--ink-2)' : ok ? 'var(--ok)' : 'var(--bad)')
        + '">' + (ok === null ? '…' : ok ? '✓' : '✕') + ' <b>' + esc(label) + '</b>'
        + (detail ? ' — ' + esc(detail) : '') + '</div>');
      paint();
    };

    out.innerHTML = '<div style="color:var(--ink-2)">Asking the phone…</div>';

    if (!bg()) { say(false, 'Location service', 'missing from this build'); return; }
    say(true, 'Location service', 'present');

    readOneFix().then(function (f) {
      say(true, 'Position from the phone', f.lat.toFixed(5) + ', ' + f.lng.toFixed(5)
        + (f.acc == null ? '' : ' ±' + Math.round(f.acc) + ' m'));
      state.lastFix = { lat: f.lat, lng: f.lng };
      state.lastFixAt = Date.now();
      state.lastAccuracyM = f.acc == null ? null : f.acc;
      state.permission = 'granted';
      render();

      if (!HAS_SERVER) { say(null, 'Sending to the office', 'no server in this build'); return null; }
      if (!state.tokens) { say(false, 'Sending to the office', 'this phone is not signed in'); return null; }
      return reportHealth().then(function (r) {
        if (r && r.received) say(true, 'The office answered', 'the connection works');
        else say(false, 'The office answered', 'no reply — check the signal');
      });
    }).catch(function (e) {
      var msg = (e && e.message) || String(e || '');
      say(false, 'Position from the phone', msg || 'no position');
      steps.push('<p class="note" style="text-align:left;margin-top:8px">'
        + 'Check the two rows above: the phone\'s location switch, and permission for this app. '
        + 'They are different settings and both must be on.</p>');
      paint();
    });
  }

  // ── my rides ───────────────────────────────────────────────────────────
  //
  // The driver's own days, from the office system: the same numbers the office
  // sees, so a driver can check them — and bring a wrong day to the office —
  // rather than take them on trust. The server only ever returns this phone's
  // driver's rides.
  function kmText(v) { return v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1) + ' km'; }
  function dayText(dayKey) {
    // Read as a calendar day: parsed at noon so no timezone can shift it.
    return new Date(dayKey + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function openHistory() {
    $('sheetTitle').textContent = 'My rides';
    $('sheetBody').innerHTML = '<p class="muted">Loading your last 30 days…</p>';
    $('sheetBg').classList.add('on');
    apiFetch('/driver/history?days=30').then(function (h) {
      if (!h.days.length) {
        $('sheetBody').innerHTML = '<p class="muted">No rides in the last 30 days yet.</p>';
        return;
      }
      var t = h.totals;
      var html = '<div style="display:flex;gap:8px;margin:0 0 14px">'
        + histTile(kmText(t.business), 'Business')
        + histTile(kmText(t.personal), 'Personal')
        + histTile(String(t.days), t.days === 1 ? 'Day' : 'Days')
        + '</div>'
        + '<p class="note" style="text-align:left;margin:0 0 12px">Business is driving to a restaurant, and between '
        + 'restaurants and the dairy. Personal is driving that did not lead to a restaurant. '
        + 'If a day looks wrong, tell the office — they can see the route.</p>'
        + h.days.map(function (d) {
          var k = d.km;
          var shops = d.restaurants.map(function (r) { return esc(r.name); }).join(', ');
          return '<div style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px">'
            + '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">'
            + '<b>' + esc(dayText(d.dayKey)) + '</b>'
            + '<span style="font-weight:700">' + (k ? kmText(k.total) : '') + '</span></div>'
            + (k
              ? '<div style="font-size:.86rem;color:var(--ink-2);margin-top:4px">'
                + '<span style="color:var(--ok);font-weight:600">' + kmText(k.business) + ' business</span>'
                + ' · ' + kmText(k.personal) + ' personal'
                + (k.unknown ? ' · ' + kmText(k.unknown) + ' undecided' : '')
                + (k.gapEstimate ? ' · ' + kmText(k.gapEstimate) + ' with no GPS' : '')
                + '</div>'
              : '<div class="note" style="text-align:left;margin-top:4px">'
                + (d.status === 'active' ? 'Today\'s ride — the kilometres appear as the day goes on.' : 'Not calculated yet.')
                + '</div>')
            + (shops ? '<div style="font-size:.8rem;color:var(--ink-2);margin-top:6px">' + d.restaurants.length
              + (d.restaurants.length === 1 ? ' restaurant: ' : ' restaurants: ') + shops + '</div>' : '')
            + '</div>';
        }).join('');
      $('sheetBody').innerHTML = html;
    }).catch(function (e) {
      $('sheetBody').innerHTML = '<p style="color:var(--bad);font-weight:600">' + esc(e.message) + '</p>'
        + '<p class="note" style="text-align:left">Your history comes from the office system, so it needs a signal.</p>';
    });
  }
  function histTile(v, label) {
    return '<div style="flex:1;background:var(--navy-soft);border-radius:12px;padding:10px 12px">'
      + '<div style="font-size:1.15rem;font-weight:750">' + esc(v) + '</div>'
      + '<div style="font-size:.74rem;color:var(--ink-2)">' + esc(label) + '</div></div>';
  }

  // ── planning a round ───────────────────────────────────────────────────
  //
  // The driver ticks where they are going; the server works out the order.
  // What makes the answer worth reading is not the ordering — with three stops
  // there are six possibilities — but that the distances behind it are this
  // driver's own, learned from their past rides. So it usually agrees with
  // what they already do, and it says so when it does.

  var stopsCache = null;
  var picked = {};
  // Named rounds ("Camp round"): the driver's saved sets of restaurants.
  var roundsCache = null;
  var roundNameDraft = '';
  var saveRoundDraft = true;

  function km(m) { return (m / 1000).toFixed(1) + ' km'; }
  function mins(s) {
    var m = Math.round(s / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  function openPlanPicker() {
    $('sheetTitle').textContent = 'Where are you going?';
    $('sheetBody').innerHTML = '<p class="muted">Loading your restaurants…</p>';
    $('sheetBg').classList.add('on');

    var load = stopsCache ? Promise.resolve(stopsCache) : apiFetch('/driver/stops');
    // Rounds are small and change from this phone only; a failure to load them
    // must not stop a driver planning.
    var loadRounds = apiFetch('/driver/rounds').then(function (r) { return r.rounds || []; }).catch(function () { return roundsCache || []; });
    Promise.all([load, loadRounds]).then(function (r) {
      var d = r[0];
      roundsCache = r[1];
      stopsCache = d;
      renderPicker('');
    }).catch(function (e) {
      $('sheetBody').innerHTML = '<p style="color:var(--bad);font-weight:600">' + esc(e.message) + '</p>';
    });
  }

  function renderPicker(q) {
    var all = (stopsCache && stopsCache.stops) || [];
    if (!all.length) {
      $('sheetBody').innerHTML = '<p class="muted">The office has not placed any restaurants on the map yet, '
        + 'so there is nothing to plan a route between.</p>';
      return;
    }
    var needle = String(q || '').toLowerCase();
    var rows = all.filter(function (s) {
      return !needle || ((s.name + ' ' + (s.area || '')).toLowerCase().indexOf(needle) !== -1);
    }).slice(0, 80);

    var rounds = roundsCache || [];
    $('sheetBody').innerHTML = (rounds.length
      ? '<p class="muted" style="margin:0 0 6px;font-size:.8rem;font-weight:700">YOUR ROUNDS</p>'
        + '<div class="rounds">' + rounds.map(function (r) {
          return '<span class="roundchip"><button type="button" data-round="' + esc(r.id) + '">' + esc(r.name)
            + ' <small>' + r.stopIds.length + '</small></button>'
            + '<button type="button" class="x" data-rounddel="' + esc(r.id) + '" aria-label="Delete ' + esc(r.name) + '">×</button></span>';
        }).join('') + '</div>'
      : '')
      + '<label style="display:block;font-size:.8rem;font-weight:700;margin:8px 0 4px">NAME THIS ROUND <span style="font-weight:400">(optional)</span></label>'
      + '<input id="roundName" maxlength="40" placeholder="e.g. Camp round" value="' + esc(roundNameDraft) + '">'
      + '<label style="display:flex;gap:8px;align-items:center;margin:6px 0 12px;font-size:.85rem"><input type="checkbox" id="roundSave"'
      + (saveRoundDraft ? ' checked' : '') + ' style="width:auto"> Save it, to pick the same round again</label>'
      + '<input id="pickSearch" placeholder="Search" value="' + esc(q || '') + '">'
      + '<div class="picklist">'
      + rows.map(function (s) {
        return '<label><input type="checkbox" data-pick="' + esc(s.id) + '"'
          + (picked[s.id] ? ' checked' : '') + '>'
          + '<span>' + esc(s.name)
          + (s.area ? '<span class="ar">' + esc(s.area) + '</span>' : '')
          + '</span></label>';
      }).join('')
      + (rows.length ? '' : '<p class="muted" style="padding:12px 4px">Nothing matches that.</p>')
      + '</div>'
      + '<p id="pickCount" class="muted" style="margin:10px 0 0;font-size:.85rem"></p>'
      + '<button id="pickGo" class="start" style="margin-top:10px">Work out the best order</button>';

    var search = $('pickSearch');
    search.addEventListener('input', function () {
      // Re-rendering the list must not interrupt somebody halfway through
      // typing a restaurant's name, so the caret goes back where it was.
      var v = search.value;
      renderPicker(v);
      var again = $('pickSearch');
      again.focus();
      try { again.setSelectionRange(v.length, v.length); } catch (e) { /* not a text input */ }
    });

    document.querySelectorAll('[data-pick]').forEach(function (box) {
      box.addEventListener('change', function () {
        var id = box.getAttribute('data-pick');
        if (box.checked) picked[id] = true; else delete picked[id];
        countPicked();
      });
    });
    $('pickGo').addEventListener('click', requestPlan);
    $('roundName').addEventListener('input', function (e) { roundNameDraft = e.target.value; });
    $('roundSave').addEventListener('change', function (e) { saveRoundDraft = e.target.checked; });
    // A saved round ticks its restaurants and fills in its name.
    document.querySelectorAll('[data-round]').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = (roundsCache || []).find(function (x) { return x.id === b.getAttribute('data-round'); });
        if (!r) return;
        picked = {};
        r.stopIds.forEach(function (id) { picked[id] = true; });
        roundNameDraft = r.name;
        renderPicker($('pickSearch') ? $('pickSearch').value : '');
      });
    });
    document.querySelectorAll('[data-rounddel]').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = (roundsCache || []).find(function (x) { return x.id === b.getAttribute('data-rounddel'); });
        if (!r || !confirm('Delete the round "' + r.name + '"?')) return;
        apiFetch('/driver/rounds/' + encodeURIComponent(r.id), { method: 'DELETE' })
          .then(function (out) { roundsCache = out.rounds || []; renderPicker($('pickSearch') ? $('pickSearch').value : ''); })
          .catch(function (e) { alert(e.message); });
      });
    });
    countPicked();
  }

  function countPicked() {
    var n = Object.keys(picked).length;
    var el = $('pickCount');
    if (el) el.textContent = n < 2 ? 'Tick at least two.' : n + ' picked.';
    var go = $('pickGo');
    if (go) go.disabled = n < 2;
  }

  function requestPlan() {
    var ids = Object.keys(picked);
    var go = $('pickGo');
    go.disabled = true;
    go.textContent = 'Working it out…';

    // The plan starts from where the driver is standing, so a fresh fix is
    // taken rather than reusing one from an hour ago.
    var name = String(roundNameDraft || '').replace(/\s+/g, ' ').trim();
    readOneFix().then(function (fix) {
      state.lastFix = fix;
      return apiFetch('/driver/plan', {
        method: 'POST',
        body: { stopIds: ids, from: { lat: fix.lat, lng: fix.lng }, name: name || undefined },
      });
    }).then(function (plan) {
      $('sheetBg').classList.remove('on');
      showPlan(plan);
      // Saved after the plan worked, so a round is never saved with a name the
      // server refused. A failure to save does not undo the plan.
      if (name && saveRoundDraft) {
        apiFetch('/driver/rounds', { method: 'POST', body: { name: name, stopIds: ids } })
          .then(function (out) { roundsCache = out.rounds || roundsCache; })
          .catch(function () { /* the plan stands; the round can be saved next time */ });
      }
    }).catch(function (e) {
      go.disabled = false;
      go.textContent = 'Work out the best order';
      var msg = e.code === 'NO_START_LOCATION' || /geolocation|timeout|position/i.test(e.message || '')
        ? 'Your location could not be read. Step outside for a moment and try again.'
        : e.message;
      var c = $('pickCount');
      if (c) c.innerHTML = '<span style="color:var(--bad)">' + esc(msg) + '</span>';
    });
  }

  function showPlan(plan) {
    var box = $('planBox');

    // Say plainly where the answer came from. A driver being told to change
    // their route deserves to know whether the app is repeating their own
    // experience back to them or guessing from a map.
    var headline = plan.followed === 'driver'
      ? '<b>Your usual order is the best one.</b><br>'
        + (plan.alternative && plan.alternative.savingM > 0
          ? 'Another order would save about ' + km(plan.alternative.savingM) + ' — not worth changing for.'
          : 'Nothing shorter was found.')
      : '<b>' + km(plan.totalDistanceM) + ' · about ' + mins(plan.totalDurationS) + '</b><br>'
        + (plan.savingM > 0
          ? 'About ' + km(plan.savingM) + ' shorter than your usual order.'
          : 'Best order for these stops.');

    var learned = plan.learnedLegs
      ? plan.learnedLegs + ' of these ' + plan.legs.length + ' journeys are measured from your own past trips.'
      : 'Estimated for now — this gets more accurate as you drive these roads.';

    box.innerHTML = (plan.name ? '<div class="planname">' + esc(plan.name) + '</div>' : '')
      + '<div class="planhead">' + headline
      + '<span style="display:block;margin-top:6px;font-size:.76rem;color:var(--ink-2)">'
      + esc(learned) + '</span></div>'
      + '<ol class="route">'
      + plan.stops.map(function (s, i) {
        var leg = plan.legs[i - 1];
        return '<li><span class="n">' + (i === 0 ? '•' : i) + '</span><span>'
          + '<span class="nm">' + esc(s.name) + '</span>'
          + (leg
            ? '<span class="sub">' + km(leg.distanceM) + ' · ' + mins(leg.durationS)
              + (leg.runs ? ' · from your ' + leg.runs + ' past trip' + (leg.runs === 1 ? '' : 's') : '')
              + '</span>'
            : '')
          + '</span></li>';
      }).join('')
      + '</ol>'
      // A stop that quietly disappears from the round is how a driver ends up
      // ringing the office. Both reasons are named.
      + (plan.onHold && plan.onHold.length
        ? '<div class="planhead" style="background:var(--warn-tint);color:var(--warn);margin-top:10px">'
          + '<b>Do not go to ' + plan.onHold.map(function (h) { return esc(h.name); }).join(', ') + '.</b><br>'
          + 'Supply is on hold'
          + (plan.onHold[0].reason ? ' — ' + esc(plan.onHold[0].reason) : '')
          + '. Left out of this round. Call the office if you think this is wrong.'
          + '</div>'
        : '')
      + (plan.unplaceable && plan.unplaceable.length
        ? '<p style="color:var(--bad);font-size:.82rem;margin-top:10px;font-weight:600">'
          + plan.unplaceable.length + ' of the places you picked have no location yet, so they were left out. '
          + 'Ask the office to place them.</p>'
        : '')
      + (plan.roadApi && plan.roadApi.error
        ? '<p style="font-size:.74rem;color:var(--ink-2);margin-top:8px">' + esc(plan.roadApi.error) + '</p>'
        : '')
      + '<button id="planClear" class="plan" style="margin-top:12px">Clear</button>';

    show(box, true);
    $('planClear').addEventListener('click', function () {
      picked = {};
      roundNameDraft = '';
      show(box, false);
      box.innerHTML = '';
    });
  }

  // ── boot ───────────────────────────────────────────────────────────────
  (function branding() {
    var t = (BRAND.theme) || {};
    var r = document.documentElement.style;
    if (t.brand) r.setProperty('--navy', t.brand);
    if (t.brandDark) r.setProperty('--navy-deep', t.brandDark);
    if (BRAND.appName) { document.title = BRAND.appName; text('introTitle', BRAND.appName); }
    if (BRAND.logo) { var l = $('introLogo'); if (l) l.src = BRAND.logo; }
    // The header is 26px. The full lockup there is an unreadable smudge, so it
    // gets the mark, falling back to the lockup if no mark is supplied.
    var small = BRAND.mark || BRAND.logo;
    if (small) document.querySelectorAll('header img').forEach(function (i) { i.src = small; });
  })();

  $('btnName').addEventListener('click', saveName);
  $('inName').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveName(); });
  $('btnStart').addEventListener('click', startRide);
  $('btnCentre').addEventListener('click', function () { followMap = true; drawRoute(); });
  $('btnWhy').addEventListener('click', openSheet);
  $('btnWhy2').addEventListener('click', openSheet);

  // The plugin can open this app's own Settings page. Nothing else can: an app
  // is not allowed to grant itself background location, so this button is the
  // whole remedy for a refused permission.
  $('btnFixPerm').addEventListener('click', function () {
    // The phone's master switch is not in this app's settings page, so sending
    // the driver there for that fault would be a dead end. Steps instead.
    if (state.permission === 'device-off') { showSettingsSteps(); return; }
    if (state.permission !== 'denied' && state.batteryExempt === false) { showBatterySteps(); return; }
    var p = bg();
    if (p && p.openSettings) {
      p.openSettings().catch(function () { showSettingsSteps(); });
    } else {
      showSettingsSteps();
    }
  });

  function showSettingsSteps() {
    var deviceOff = state.permission === 'device-off';
    $('sheetTitle').textContent = deviceOff ? 'Turn the phone\'s location on' : 'Allow location for this app';
    $('sheetBody').innerHTML = '<p class="note" style="text-align:left;margin:0 0 10px">'
      + 'These are two different settings and both are needed: the <b>phone\'s</b> location '
      + 'switch, and permission for <b>this app</b>.</p>'
      + '<ol style="font-size:.9rem;line-height:1.85;padding-left:20px;margin:0">'
      + (deviceOff
        ? '<li>Swipe down from the top of the screen</li>'
          + '<li>Tap <b>Location</b> so it turns on</li>'
          + '<li>Come back to this app — it starts recording by itself</li>'
        : '<li>Open the phone\'s <b>Settings</b></li>'
          + '<li><b>Apps</b> → <b>Modern Drivers</b></li>'
          + '<li><b>Permissions</b> → <b>Location</b></li>'
          + '<li>Choose <b>Allow all the time</b></li>')
      + '</ol>'
      + '<p class="note" style="text-align:left;margin-top:12px">'
      + '"While using the app" also works: once a ride has been started with the app open, '
      + 'Android keeps recording with the screen locked and shows a notification the whole time.</p>';
    $('sheetBg').classList.add('on');
  }
  $('btnPlan').addEventListener('click', openPlanPicker);
  $('btnHistory').addEventListener('click', openHistory);
  $('sheetClose').addEventListener('click', function () { $('sheetBg').classList.remove('on'); });
  $('sheetBg').addEventListener('click', function (e) { if (e.target === $('sheetBg')) $('sheetBg').classList.remove('on'); });
  window.addEventListener('online', function () { sync(); render(); });
  window.addEventListener('offline', render);

  /* Coming back to the app.
   *
   * The retry below is the other half of the permission fix. A driver who is
   * told to turn location on leaves the app to do it; without this, they come
   * back to an app that has given up and will not ask the phone again until it
   * is force-closed. Starting a watcher that is already running is a no-op, so
   * this is safe to call on every resume.
   */
  function resume() {
    queue.count().then(function (n) { state.queued = n; render(); });
    if (riding() && !state.watcherId) startWatcher();
    // Back from the battery dialog or Settings: find out what was chosen.
    if (riding()) checkBattery(false);
    if (!primed || state.permission === 'denied' || state.permission === 'device-off') {
      primed = false;
      primeLocation();
    }
    if (HAS_SERVER) { checkRide(); sync(); }
    else if (state.localRide) { initMap(); startWatcher(); }
  }
  // Through registerPlugin like every other plugin. Capacitor.Plugins.App is
  // only filled in by older runtimes, so the old check here was silently false
  // and "come back from Settings and it retries" never fired through this path.
  if (window.Capacitor && window.Capacitor.registerPlugin) {
    try {
      window.Capacitor.registerPlugin('App')
        .addListener('appStateChange', function (s) { if (s.isActive) resume(); });
    } catch (e) { /* visibilitychange below still covers resume */ }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resume(); });

  render();
  if (state.name) { resume(); primeLocation(); }

  if (HAS_SERVER) {
    setInterval(sync, (CFG.SYNC_INTERVAL_SEC || 45) * 1000);
    setInterval(checkRide, (CFG.RIDE_POLL_SEC || 60) * 1000);
    // Only while a ride is running: outside one there is nothing the office can
    // act on, and forty idle phones reporting all day is noise and bandwidth.
    setInterval(function () { if (riding()) reportHealth(); }, 5 * 60 * 1000);
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
