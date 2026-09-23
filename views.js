/* Dashboard views.
 *
 * Plain DOM rendering, one function per tab. No framework: the whole dashboard
 * is seven screens over one REST API, and a build step would cost more than it
 * saves for the people who will maintain this.
 *
 * House rule that shows up everywhere below: a number the system is not sure
 * about is displayed next to the reason it is not sure, never on its own.
 */
window.DRIVERS_VIEWS = (function () {
  'use strict';
  var API = window.DRIVERS_API;
  var MAPS = window.DRIVERS_MAP;
  var esc = MAPS.esc;

  var state = {
    tab: 'fleet',
    dashboard: null,
    staleAfterSec: (window.DRIVERS_CONFIG || {}).STALE_AFTER_SEC || 180,
    filterText: '',
    filterStatus: 'all',
    map: null,
    markers: {},
    replay: null,
    currentRide: null,
  };

  var TABS = [
    ['fleet', 'Live fleet'],
    ['drivers', 'Drivers'],
    ['review', 'Review'],
    ['places', 'Locations'],
    ['orders', 'Deliveries'],
    ['reports', 'Reports'],
    ['alerts', 'Alerts'],
    ['settings', 'Settings'],
  ];

  // ── helpers ────────────────────────────────────────────────────────────
  var view = function () { return document.getElementById('view'); };
  function set(html) { view().innerHTML = html; }
  function on(sel, evt, fn, root) {
    (root || view()).querySelectorAll(sel).forEach(function (el) { el.addEventListener(evt, fn); });
  }
  function ago(sec) {
    if (sec == null) return '—';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.round(sec / 60) + ' min';
    return Math.round(sec / 36) / 100 + ' h';
  }
  function time(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }
  function dateTime(ms) { return ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function km(v) { return v == null ? '—' : v.toFixed(1) + ' km'; }
  function dayStartMs(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
  function todayISO() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

  function spinner(msg) { return '<p class="muted">' + esc(msg || 'Loading…') + '</p>'; }
  function errBox(e) { return '<div class="card"><p class="err">' + esc(e.message || String(e)) + '</p></div>'; }

  function modal(html) {
    document.getElementById('modal').innerHTML = html;
    document.getElementById('modalBg').classList.add('on');
  }
  function closeModal() { document.getElementById('modalBg').classList.remove('on'); }
  document.getElementById('modalBg').addEventListener('click', function (e) {
    if (e.target.id === 'modalBg') closeModal();
  });

  // ── tabs ───────────────────────────────────────────────────────────────
  function renderTabs() {
    document.getElementById('tabs').innerHTML = TABS.map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? 'on' : '') + '">' + esc(t[1]) + '</button>';
    }).join('');
    on('[data-tab]', 'click', function (e) { go(e.currentTarget.dataset.tab); }, document.getElementById('tabs'));
  }

  function go(tab) {
    state.tab = tab;
    state.map = null; state.markers = {}; state.replay = null;
    renderTabs();
    render();
  }

  function render() {
    var fn = ({
      fleet: renderFleet, drivers: renderDrivers, review: renderReview, places: renderPlaces,
      orders: renderOrders, reports: renderReports, alerts: renderAlerts, settings: renderSettings,
    })[state.tab];
    set(spinner());
    fn().catch(function (e) { set(errBox(e)); });
  }

  // ── Live fleet ─────────────────────────────────────────────────────────
  function renderFleet() {
    return API.dashboard().then(function (d) {
      state.dashboard = d;
      state.staleAfterSec = d.staleAfterSec;
      var m = d.metrics;
      set(''
        + '<div class="grid metrics" style="margin-bottom:14px">'
        + metric(m.activeDrivers, 'Drivers on a ride', 'ok')
        + metric(m.completedRides, 'Rides finished today')
        + metric(km(m.totalKm), 'Total tracked today')
        + metric(km(m.verifiedBusinessKm), 'Verified business', 'ok')
        + metric(km(m.unknownKm), 'Unknown — needs review', m.unknownKm > 0 ? 'warn' : '')
        + metric(m.trackingIssues, 'Tracking problems', m.trackingIssues ? 'bad' : '')
        + metric(m.openAlerts, 'Open alerts', m.openAlerts ? 'warn' : '')
        + metric(m.unprocessedRides, 'Rides not calculated', m.unprocessedRides ? 'warn' : '')
        + '</div>'
        + (m.unprocessedRides
          ? '<div class="banner">' + m.unprocessedRides + ' finished ride(s) today have not been calculated yet, so their kilometres are not in the totals above. They are processed automatically, or you can run it now from Settings.</div>'
          : '')
        + '<div class="split">'
        + '  <div class="card">'
        + '    <h2>Drivers</h2>'
        + '    <div class="bar">'
        + '      <div style="flex:1"><input id="fFilter" placeholder="Search name or driver ID" value="' + esc(state.filterText) + '"></div>'
        + '      <div><select id="fStatus">'
        + ['all', 'active', 'finished', 'not_started'].map(function (s) {
          return '<option value="' + s + '"' + (state.filterStatus === s ? ' selected' : '') + '>' + esc({ all: 'All', active: 'On a ride', finished: 'Finished today', not_started: 'Not started' }[s]) + '</option>';
        }).join('') + '</select></div>'
        + '    </div>'
        + '    <div style="overflow-x:auto">' + fleetTable(d.drivers) + '</div>'
        + '    <p class="tiny" style="margin-top:10px">A position is called <b>live</b> only if it arrived in the last ' + d.staleAfterSec + ' seconds. Anything older is labelled <b>last known</b>.</p>'
        + '  </div>'
        + '  <div class="card">'
        + '    <h2>Live map</h2>'
        + '    <div id="map"></div>'
        + '    <div class="legend">'
        + '      <span><i style="background:#1a7a4c"></i>Live</span>'
        + '      <span><i style="background:#8a5f14"></i>Last known (stale)</span>'
        + '      <span><i style="background:#98a2b3"></i>No position</span>'
        + '    </div>'
        + '  </div>'
        + '</div>');

      document.getElementById('fFilter').addEventListener('input', function (e) {
        state.filterText = e.target.value;
        document.querySelector('#view .split .card div[style*="overflow-x"]').innerHTML = fleetTable(state.dashboard.drivers);
        bindFleetRows();
      });
      document.getElementById('fStatus').addEventListener('change', function (e) {
        state.filterStatus = e.target.value;
        document.querySelector('#view .split .card div[style*="overflow-x"]').innerHTML = fleetTable(state.dashboard.drivers);
        bindFleetRows();
      });
      bindFleetRows();

      state.map = MAPS.create('map');
      state.markers = {};
      if (state.map) {
        state.map.once('load', function () {
          MAPS.syncMarkers({ map: state.map, markers: state.markers }, d.drivers, openDriver);
          var coords = d.drivers.filter(function (x) { return x.lastLocation; }).map(function (x) { return [x.lastLocation.lng, x.lastLocation.lat]; });
          MAPS.fitTo(state.map, coords);
        });
      }
      scheduleRefresh();
    });
  }

  function metric(v, label, cls) {
    return '<div class="metric ' + (cls || '') + '"><div class="v">' + esc(String(v)) + '</div><div class="l">' + esc(label) + '</div></div>';
  }

  function filteredDrivers(rows) {
    var q = state.filterText.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.filterStatus !== 'all' && r.rideStatus !== state.filterStatus) return false;
      if (!q) return true;
      return (r.name || '').toLowerCase().indexOf(q) !== -1 || (r.driverCode || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function fleetTable(rows) {
    var list = filteredDrivers(rows);
    if (!list.length) return '<p class="muted">No drivers match.</p>';
    return '<table><thead><tr>'
      + '<th>Driver</th><th>Ride</th><th>Position</th><th>Updated</th><th>Health</th><th>Today</th>'
      + '</tr></thead><tbody>'
      + list.map(function (r) {
        var today = !r.today.calculated
          ? '<span class="tiny">not calculated</span>'
          : km(r.today.totalKm) + '<br><span class="tiny">' + km(r.today.verifiedBusinessKm) + ' verified · ' + km(r.today.unknownKm) + ' unknown</span>';
        return '<tr class="click" data-driver="' + esc(r.driverId) + '" data-ride="' + esc(r.rideId || '') + '">'
          + '<td><b>' + esc(r.name) + '</b><br><span class="tiny">' + esc(r.driverCode) + (r.status !== 'active' ? ' · inactive' : '') + '</span></td>'
          + '<td><span class="pill ' + esc(r.rideStatus === 'active' ? 'active' : 'idle') + '">' + esc(r.rideStatus.replace('_', ' ')) + '</span>'
          + (r.rideStartedAt ? '<br><span class="tiny">from ' + time(r.rideStartedAt) + '</span>' : '') + '</td>'
          + '<td><span class="pill ' + esc(r.locationState) + '">' + esc(r.locationState === 'live' ? 'live' : r.locationState === 'stale' ? 'last known' : 'none') + '</span></td>'
          + '<td>' + esc(ago(r.lastUpdateAgeSec)) + '</td>'
          + '<td><span class="pill ' + esc(r.trackingHealth) + '">' + esc(r.trackingHealth.replace('_', ' ')) + '</span></td>'
          + '<td>' + today + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table>';
  }

  function bindFleetRows() {
    on('tr[data-driver]', 'click', function (e) {
      var row = state.dashboard.drivers.find(function (d) { return d.driverId === e.currentTarget.dataset.driver; });
      if (row) openDriver(row);
    });
  }

  var refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      if (state.tab !== 'fleet' || !state.map) return;
      API.dashboard().then(function (d) {
        state.dashboard = d;
        MAPS.syncMarkers({ map: state.map, markers: state.markers }, d.drivers, openDriver);
        var holder = document.querySelector('#view .split .card div[style*="overflow-x"]');
        if (holder) { holder.innerHTML = fleetTable(d.drivers); bindFleetRows(); }
        scheduleRefresh();
      }).catch(scheduleRefresh);
    }, ((window.DRIVERS_CONFIG || {}).REFRESH_SEC || 20) * 1000);
  }

  // ── Driver / ride detail ───────────────────────────────────────────────
  function openDriver(row) {
    modal(spinner('Loading ' + esc(row.name) + '…'));
    var params = { driverId: row.driverId, from: dayStartMs(new Date()) - 13 * 864e5 };
    API.rides(params).then(function (rides) {
      var html = '<h3 style="margin:0 0 4px">' + esc(row.name) + '</h3>'
        + '<p class="tiny" style="margin:0 0 14px">' + esc(row.driverCode) + '</p>';
      if (row.rideStatus === 'active') {
        html += '<div class="card" style="margin-bottom:12px"><h2>Active ride</h2>'
          + '<p class="muted">Started ' + dateTime(row.rideStartedAt) + ' · last position ' + esc(ago(row.lastUpdateAgeSec)) + ' ago'
          + ' (<b>' + esc(row.locationState === 'live' ? 'live' : 'last known, NOT live') + '</b>)</p>'
          + '<button class="btn-danger btn-sm" id="btnStop">Stop this ride</button> '
          + '<button class="btn-outline btn-sm" id="btnEmergency">Emergency stop</button>'
          + '<p class="tiny" style="margin-top:8px">The driver cannot stop a ride from the app. Every stop records who did it, when, and why.</p>'
          + '</div>';
      }
      html += '<div class="card"><h2>Rides — last 14 days</h2>'
        + (rides.length ? '<table><thead><tr><th>Day</th><th>Started</th><th>Ended</th><th>Status</th><th>Points</th><th></th></tr></thead><tbody>'
          + rides.map(function (r) {
            return '<tr><td>' + esc(r.dayKey) + '</td><td>' + time(r.startedAt) + '</td><td>' + time(r.stoppedAt) + '</td>'
              + '<td><span class="pill ' + (r.status === 'active' ? 'active' : 'idle') + '">' + esc(r.status) + '</span>'
              + (r.stopReason ? '<br><span class="tiny">' + esc(r.stopReason) + '</span>' : '') + '</td>'
              + '<td>' + (r.pointCount || 0) + '</td>'
              + '<td><button class="btn-outline btn-sm" data-openride="' + esc(r.id) + '">Open</button></td></tr>';
          }).join('') + '</tbody></table>'
          : '<p class="muted">No rides recorded in this period.</p>')
        + '</div>'
        + '<button class="btn-outline" id="btnCloseModal" style="margin-top:12px">Close</button>';
      modal(html);
      var root = document.getElementById('modal');
      on('#btnCloseModal', 'click', closeModal, root);
      on('[data-openride]', 'click', function (e) { openRide(e.currentTarget.dataset.openride); }, root);
      on('#btnStop', 'click', function () { promptStop(row.rideId, false); }, root);
      on('#btnEmergency', 'click', function () { promptStop(row.rideId, true); }, root);
    }).catch(function (e) { modal(errBox(e) + '<button class="btn-outline" onclick="document.getElementById(\'modalBg\').classList.remove(\'on\')">Close</button>'); });
  }

  function promptStop(rideId, emergency) {
    modal('<h3>' + (emergency ? 'Emergency stop' : 'Stop this ride') + '</h3>'
      + '<p class="muted">The reason is recorded in the audit log against your account. It is required.</p>'
      + '<div class="field"><label for="stopReason">Reason</label><input id="stopReason" placeholder="e.g. End of shift — driver returned to the dairy"></div>'
      + '<p id="stopErr" class="err" hidden></p>'
      + '<button class="' + (emergency ? 'btn-danger' : 'btn-primary') + '" id="stopGo">' + (emergency ? 'Emergency stop' : 'Stop ride') + '</button> '
      + '<button class="btn-outline" id="stopCancel">Cancel</button>');
    var root = document.getElementById('modal');
    on('#stopCancel', 'click', closeModal, root);
    on('#stopGo', 'click', function () {
      var reason = document.getElementById('stopReason').value.trim();
      var err = document.getElementById('stopErr');
      if (reason.length < 3) { err.textContent = 'Please give a reason.'; err.hidden = false; return; }
      document.getElementById('stopGo').disabled = true;
      API.stopRide(rideId, reason, emergency).then(function () { closeModal(); render(); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; document.getElementById('stopGo').disabled = false; });
    }, root);
  }

  // Full ride view: distances with their provenance, the segment list with
  // evidence, and the replay map drawn from the RAW points.
  function openRide(rideId) {
    modal(spinner('Loading ride…'));
    Promise.all([API.ride(rideId, true), API.places('restaurants'), API.places('facilities')]).then(function (r) {
      var data = r[0];
      var restaurants = r[1];
      var facilities = r[2];
      state.currentRide = data;
      var p = data.processing;
      var d = p && p.distance;

      var html = '<h3 style="margin:0 0 2px">' + esc(data.ride.driverName || data.ride.driverId) + ' — ' + esc(data.ride.dayKey) + '</h3>'
        + '<p class="tiny" style="margin:0 0 12px">' + dateTime(data.ride.startedAt) + ' → ' + (data.ride.stoppedAt ? dateTime(data.ride.stoppedAt) : 'still running')
        + ' · ' + (data.ride.pointCount || 0) + ' GPS fixes</p>';

      if (!p) {
        html += '<div class="banner">This ride has not been calculated yet, so there are no kilometres to show. '
          + '<button class="btn-sm btn-primary" id="btnProcess">Calculate now</button></div>';
      } else {
        html += '<div class="grid metrics" style="margin-bottom:12px">'
          + metric(km(d.km.verifiedBusiness), 'Verified business', 'ok')
          + metric(km(d.km.likelyBusiness), 'Likely business', 'warn')
          + metric(km(d.km.personal), 'Personal')
          + metric(km(d.km.unknown), 'Unknown', d.km.unknown > 0 ? 'warn' : '')
          + metric(km(d.km.gapEstimate), 'GPS gap (estimate)')
          + metric(km(d.km.dayTotal), 'Day total')
          + '</div>'
          + '<div class="evidence"><b>How this adds up.</b> '
          + esc(d.reconciliation.explanation)
          + ' Residual: ' + d.reconciliation.bucketResidualM + ' m ('
          + (d.reconciliation.ok ? 'reconciled' : 'NOT RECONCILED — report this') + ').<br>'
          + esc(d.methodNote) + '<br>'
          + 'GPS quality: <b>' + esc(p.track.quality.grade) + '</b>'
          + (p.track.quality.reasons.length ? ' — ' + esc(p.track.quality.reasons.join('; ')) : '')
          + '<br>Calculated with version ' + esc(p.calcVersion) + ' at ' + dateTime(p.processedAt) + '.'
          + '</div>';
      }

      html += '<div class="card"><h2>Route replay</h2><div id="replayMap"></div>'
        + '<p class="tiny" style="margin-top:8px">Grey dots are fixes excluded from the distance (poor accuracy, impossible jumps, duplicates). They are kept and shown, never deleted.</p></div>';

      if (p) {
        html += '<div class="card"><h2>Segments</h2><div style="overflow-x:auto"><table><thead><tr>'
          + '<th>Time</th><th>What</th><th>Confidence</th><th>Distance</th><th>Evidence</th><th></th></tr></thead><tbody>'
          + p.segments.map(function (s) {
            return '<tr>'
              + '<td>' + time(s.startTs) + '<br><span class="tiny">' + time(s.endTs) + '</span></td>'
              + '<td><b>' + esc(s.type.replace(/_/g, ' ').toLowerCase()) + '</b>'
              + (s.place ? '<br><span class="tiny">' + esc(s.place.name) + '</span>' : '')
              + (s.originalType ? '<br><span class="tiny">was ' + esc(s.originalType.replace(/_/g, ' ').toLowerCase()) + ', changed by ' + esc(s.reviewedBy || 'an admin') + '</span>' : '')
              + '</td>'
              + '<td><span class="pill ' + esc(s.confidence) + '">' + esc(s.confidence) + '</span>'
              + (s.needsReview ? '<br><span class="tiny">needs review</span>' : '') + '</td>'
              + '<td>' + (s.distanceM / 1000).toFixed(2) + ' km'
              + (s.gapEstimateM ? '<br><span class="tiny">+' + (s.gapEstimateM / 1000).toFixed(2) + ' km estimated</span>' : '') + '</td>'
              + '<td class="tiny">' + esc((s.evidence || []).map(function (x) { return x.detail; }).join(' · ')) + '</td>'
              + '<td><button class="btn-outline btn-sm" data-review="' + esc(s.id) + '">Reclassify</button></td>'
              + '</tr>';
          }).join('')
          + '</tbody></table></div></div>';

        if (p.matching) {
          html += '<div class="card"><h2>Delivery matching</h2>'
            + '<p class="muted">' + p.matching.summary.matched + ' matched · ' + p.matching.summary.possible + ' possible · '
            + p.matching.summary.unmatchedVisits + ' visits with no order · ' + p.matching.summary.unmatchedOrders + ' orders with no visit</p>'
            + '<p class="tiny">' + esc(p.matching.summary.distanceNote) + '</p>'
            + (p.matching.unmatchedVisits.length
              ? '<table><thead><tr><th>Visit</th><th>Location</th><th>Why unmatched</th></tr></thead><tbody>'
              + p.matching.unmatchedVisits.map(function (v) {
                return '<tr><td>' + time(v.visitAt) + '</td><td>' + esc(v.placeName || '—') + '</td><td class="tiny">' + esc(v.reason) + '</td></tr>';
              }).join('') + '</tbody></table>' : '')
            + '</div>';
        }
      }

      if (data.reviews && data.reviews.length) {
        html += '<div class="card"><h2>Classification history</h2><table><thead><tr><th>When</th><th>Who</th><th>Segment</th><th>Change</th><th>Note</th><th></th></tr></thead><tbody>'
          + data.reviews.map(function (rv) {
            return '<tr><td>' + dateTime(rv.at) + '</td><td>' + esc(rv.reviewerId) + '</td><td>' + esc(rv.segmentId) + '</td>'
              + '<td class="tiny">' + esc(rv.fromType) + ' → ' + esc(rv.toType) + (rv.reverted ? ' <b>(reverted)</b>' : rv.superseded ? ' (superseded)' : '') + '</td>'
              + '<td class="tiny">' + esc(rv.note || '') + '</td>'
              + '<td>' + (rv.reverted || rv.superseded ? '' : '<button class="btn-outline btn-sm" data-revert="' + esc(rv.id) + '">Revert</button>') + '</td></tr>';
          }).join('') + '</tbody></table>'
          + '<p class="tiny" style="margin-top:8px">Reviews are appended, never overwritten, and they never change the raw GPS.</p></div>';
      }

      html += '<button class="btn-outline" id="btnCloseModal">Close</button>';
      modal(html);
      var root = document.getElementById('modal');
      on('#btnCloseModal', 'click', closeModal, root);
      on('#btnProcess', 'click', function () {
        this.disabled = true;
        API.processRide(rideId).then(function () { openRide(rideId); }).catch(function (e) { alert(e.message); });
      }, root);
      on('[data-review]', 'click', function (e) { promptReview(rideId, e.currentTarget.dataset.review); }, root);
      on('[data-revert]', 'click', function (e) {
        if (!confirm('Revert this reclassification? The original machine verdict comes back and the revert is recorded.')) return;
        API.revertReview(e.currentTarget.dataset.revert).then(function () { openRide(rideId); }).catch(function (err) { alert(err.message); });
      }, root);

      var m = MAPS.create('replayMap', { zoom: 12 });
      if (m && data.points && data.points.length) {
        m.once('load', function () {
          // Which fixes the calculation excluded, and why. This comes from the
          // processing result, not from the raw documents — the raw documents
          // are never annotated, because they are never modified.
          var excluded = {};
          if (p && p.track && p.track.excludedPoints) {
            p.track.excludedPoints.forEach(function (x) { excluded[x.clientPointId] = x.quality; });
          }
          var pts = data.points.map(function (pt) {
            return {
              lat: pt.lat, lng: pt.lng,
              quality: excluded[pt.clientPointId] || 'ok',
              countDistance: !excluded[pt.clientPointId],
            };
          });
          MAPS.drawRoute(m, 'ride', pts);
          // A restaurant awaiting a location has no coordinates at all; it is
          // not on the map, and the engine does not count it either.
          MAPS.drawPlaces(m, 'restaurants', restaurants.filter(function (x) { return x.active !== false && hasPin(x); }), '#D7262F');
          MAPS.drawPlaces(m, 'facilities', facilities, '#1B2A6B');
          MAPS.fitTo(m, pts.map(function (pt) { return [pt.lng, pt.lat]; }));
        });
      }
    }).catch(function (e) { modal(errBox(e) + '<button class="btn-outline" id="btnCloseModal">Close</button>'); on('#btnCloseModal', 'click', closeModal, document.getElementById('modal')); });
  }

  var REVIEW_TYPES = [
    ['TRAVEL_BETWEEN_BUSINESS_LOCATIONS', 'Business travel between locations'],
    ['MODERN_DAIRY_DEPARTURE', 'Leaving a Modern Dairy facility'],
    ['RETURN_TO_MODERN_DAIRY', 'Returning to a Modern Dairy facility'],
    ['LIKELY_RESTAURANT_VISIT', 'Restaurant / customer visit'],
    ['BUSINESS_TRAVEL', 'Business travel (other)'],
    ['PERSONAL_OR_NON_BUSINESS', 'Personal / Porter work'],
    ['UNKNOWN', 'Unknown — leave for later'],
  ];

  function promptReview(rideId, segmentId) {
    modal('<h3>Reclassify segment</h3>'
      + '<p class="muted">This adds a new decision with your name against it. The original classification and the raw GPS are untouched.</p>'
      + '<div class="field"><label for="rvType">Classify as</label><select id="rvType">'
      + REVIEW_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + esc(t[1]) + '</option>'; }).join('')
      + '</select></div>'
      + '<div class="field"><label for="rvNote">Why (recorded in the audit log)</label><textarea id="rvNote" rows="3" placeholder="e.g. Driver confirmed this was a delivery to Hotel Shreyas; the geofence radius is too small."></textarea></div>'
      + '<p id="rvErr" class="err" hidden></p>'
      + '<button class="btn-primary" id="rvGo">Save decision</button> <button class="btn-outline" id="rvCancel">Cancel</button>');
    var root = document.getElementById('modal');
    on('#rvCancel', 'click', function () { openRide(rideId); }, root);
    on('#rvGo', 'click', function () {
      var toType = document.getElementById('rvType').value;
      var note = document.getElementById('rvNote').value.trim();
      document.getElementById('rvGo').disabled = true;
      API.review(rideId, segmentId, toType, note).then(function () { openRide(rideId); })
        .catch(function (e) {
          var err = document.getElementById('rvErr');
          err.textContent = e.message; err.hidden = false;
          document.getElementById('rvGo').disabled = false;
        });
    }, root);
  }

  // ── Drivers ────────────────────────────────────────────────────────────
  // Nothing is created here. A driver types their name and phone number into
  // the app and appears in this list; the office's job is to check the list and
  // switch off anyone who should not be on it.
  function renderDrivers() {
    return API.drivers(true).then(function (list) {
      var pending = list.filter(function (d) { return !d.vehicleId; }).length;
      set('<div class="card"><h2>Drivers (' + list.length + ')</h2>'
        + '<p class="muted">Drivers add themselves from the app with their name and mobile number — there is nothing to issue and no code to hand out. '
        + 'Anyone who should not be here can be switched off, and their phone stops recording immediately.</p>'
        + (list.length === 0
          ? '<p class="muted" style="margin-top:14px"><b>Nobody has registered yet.</b> Install the app on a driver\'s phone, let them enter their name and number, and they will appear here.</p>'
          : '<div style="overflow-x:auto;margin-top:14px"><table><thead><tr>'
            + '<th>Driver ID</th><th>Name</th><th>Mobile</th><th>Vehicle</th><th>Status</th><th>Last seen</th><th></th></tr></thead><tbody>'
            + list.map(function (d) {
              return '<tr>'
                + '<td><b>' + esc(d.driverCode) + '</b></td>'
                + '<td>' + esc(d.name)
                + (d.selfReportedName ? '<br><span class="tiny">typed "' + esc(d.selfReportedName) + '" in the app</span>' : '') + '</td>'
                + '<td>' + esc(d.phone || '—') + '</td>'
                + '<td>' + esc(d.vehicleId || '—') + '</td>'
                + '<td><span class="pill ' + (d.status === 'active' ? 'active' : 'idle') + '">' + esc(d.status) + '</span></td>'
                + '<td class="tiny">' + (d.lastSeenAt ? dateTime(d.lastSeenAt) : 'never') + '</td>'
                + '<td style="white-space:nowrap">'
                + '<button class="btn-outline btn-sm" data-edit="' + esc(d.id) + '">Edit</button> '
                + '<button class="btn-outline btn-sm" data-toggle="' + esc(d.id) + '" data-status="' + esc(d.status) + '">'
                + (d.status === 'active' ? 'Switch off' : 'Switch on') + '</button>'
                + '</td></tr>';
            }).join('')
            + '</tbody></table></div>')
        + '</div>'
        + (pending && list.length
          ? '<div class="banner info">' + pending + ' driver(s) have no vehicle assigned. That is optional — it only affects reporting.</div>'
          : ''));

      on('[data-toggle]', 'click', function (e) {
        var next = e.currentTarget.dataset.status === 'active' ? 'inactive' : 'active';
        var verb = next === 'inactive' ? 'Switch off' : 'Switch on';
        if (!confirm(verb + ' this driver?' + (next === 'inactive'
          ? ' Their phone stops recording immediately and they cannot start a ride.'
          : ' They will be able to start rides again.'))) return;
        API.setDriverStatus(e.currentTarget.dataset.toggle, next).then(render)
          .catch(function (err) { alert(err.message); });
      });

      on('[data-edit]', 'click', function (e) {
        var d = list.find(function (x) { return x.id === e.currentTarget.dataset.edit; });
        modal('<h3>' + esc(d.name) + '</h3>'
          + '<p class="tiny">' + esc(d.driverCode) + ' · ' + esc(d.phone || '') + '</p>'
          + '<div class="field" style="margin-top:14px"><label>Name on record</label><input id="eName" value="' + esc(d.name) + '"></div>'
          + '<div class="field"><label>Vehicle (optional)</label><input id="eVehicle" value="' + esc(d.vehicleId || '') + '" placeholder="e.g. MH12AB1234"></div>'
          + '<div class="field"><label>Notes (optional)</label><textarea id="eNotes" rows="2">' + esc(d.notes || '') + '</textarea></div>'
          + '<p class="tiny">The mobile number is the account and cannot be changed here — a driver with a new number registers again and the old account is switched off.</p>'
          + '<p id="eErr" class="err" hidden></p>'
          + '<button class="btn-primary" id="eSave" style="width:auto">Save</button> '
          + '<button class="btn-outline" id="eCancel">Cancel</button>');
        var root = document.getElementById('modal');
        on('#eCancel', 'click', closeModal, root);
        on('#eSave', 'click', function () {
          API.updateDriver(d.id, {
            name: document.getElementById('eName').value.trim(),
            vehicleId: document.getElementById('eVehicle').value.trim() || null,
            notes: document.getElementById('eNotes').value.trim() || null,
          }).then(function () { closeModal(); render(); })
            .catch(function (ex) { var el2 = document.getElementById('eErr'); el2.textContent = ex.message; el2.hidden = false; });
        }, root);
      });
    });
  }

  // ── Review queue ───────────────────────────────────────────────────────
  function renderReview() {
    return API.reviewQueue({}).then(function (q) {
      set('<div class="card"><h2>Segments needing review</h2>'
        + '<p class="muted">' + q.pending + ' segment(s) across the last 14 days. These kilometres are <b>not</b> in anyone\'s verified business total until someone decides.</p>'
        + (q.segments.length
          ? '<div style="overflow-x:auto"><table><thead><tr><th>Day</th><th>Driver</th><th>When</th><th>Current</th><th>Distance</th><th>Why it is uncertain</th><th></th></tr></thead><tbody>'
          + q.segments.map(function (s) {
            return '<tr>'
              + '<td>' + esc(s.dayKey) + '</td><td>' + esc(s.driverName || s.driverId) + '</td>'
              + '<td>' + time(s.startTs) + '</td>'
              + '<td><b>' + esc(s.type.replace(/_/g, ' ').toLowerCase()) + '</b><br><span class="pill ' + esc(s.confidence) + '">' + esc(s.confidence) + '</span></td>'
              + '<td>' + (s.distanceM / 1000).toFixed(2) + ' km' + (s.gapEstimateM ? '<br><span class="tiny">+' + (s.gapEstimateM / 1000).toFixed(2) + ' est.</span>' : '') + '</td>'
              + '<td class="tiny">' + esc((s.evidence || []).map(function (x) { return x.detail; }).join(' · '))
              + (s.nearbyPlaces ? '<br><b>Nearby:</b> ' + esc(s.nearbyPlaces.map(function (n) { return n.name + ' (' + n.distanceM + ' m)'; }).join(', ')) : '')
              + '</td>'
              + '<td><button class="btn-outline btn-sm" data-open="' + esc(s.rideId) + '">Open ride</button></td>'
              + '</tr>';
          }).join('') + '</tbody></table></div>'
          : '<p class="muted">Nothing is waiting. Every segment in this period has a confident classification.</p>')
        + '</div>');
      on('[data-open]', 'click', function (e) { openRide(e.currentTarget.dataset.open); });
    });
  }

  // ── Locations ──────────────────────────────────────────────────────────
  function renderPlaces() {
    return Promise.all([
      API.places('restaurants'), API.places('facilities'), API.awaitingLocation(),
      API.integrationSecrets().catch(function () { return {}; }),
    ]).then(function (r) {
      var restaurants = r[0];
      var facilities = r[1];
      var await_ = r[2] || {};
      var awaiting = await_.rows || [];
      var counts = await_.counts
        || { total: awaiting.length, pending: 0, unconfirmed: 0, business: 0, street: 0, areaOnly: 0, notFound: 0 };
      var secrets = r[3] || {};
      // Order matters here. The three things the office actually does — paste
      // the key, upload the file, run the lookup — come first, because the
      // restaurant list below them is three thousand rows long and the buttons
      // were impossible to find underneath it.
      set(geocodingKeyCard(secrets)
        + awaitingCard(awaiting, counts)
        + '<div class="card"><h2>Import / export</h2>'
        + '<p class="muted">Upload the Excel file straight from the office — <code>.xlsx</code> or <code>.csv</code>, either works. '
        + 'Only <code>name</code> is required (a column called <code>Customer Name</code> counts). <code>address</code> makes the location lookup far more accurate; '
        + '<code>lat</code> and <code>lng</code> skip it entirely. Other columns: <code>customer_id, radius_m, external_id, schedule, active</code>.</p>'
        + '<p class="muted">Re-upload the same file whenever you add a restaurant. Rows already here are matched by name and area, so only the new ones are added — '
        + 'and <b>a pin you have placed or corrected is never overwritten</b>.</p>'
        + '<input type="file" id="csvFile" accept=".csv,.xlsx,text/csv" style="margin-bottom:10px">'
        + '<p id="pickedMsg" class="tiny" style="margin:0 0 10px">'
        + (pickedFile ? 'Holding <b>' + esc(pickedFile.name) + '</b> — it stays chosen while you move around.' : 'No file chosen yet.')
        + '</p>'
        + '<div><button class="btn-primary" id="btnImport">Import restaurants</button> '
        + '<button class="btn-outline" id="btnExport">Export restaurants CSV</button></div>'
        + '<p id="impMsg" class="muted" style="margin-top:10px"></p>'
        + '</div>'
        + '<div class="card"><h2>Restaurants and delivery locations ('
        + restaurants.filter(hasPin).length + ' on the map'
        + (restaurants.length - restaurants.filter(hasPin).length
          ? ', ' + (restaurants.length - restaurants.filter(hasPin).length) + ' still without one'
          : '') + ')</h2>'
        + '<p class="muted">A geofence hit is evidence that the driver was <b>at</b> a place. It is not proof that a delivery happened — that comes from the order records.</p>'
        + placeTable(restaurants, 'restaurants')
        + placeForm('restaurants')
        + '</div>'
        + '<div class="card"><h2>Modern Dairy facilities (' + facilities.length + ')</h2>'
        + placeTable(facilities, 'facilities')
        + placeForm('facilities')
        + '</div>');

      bindPlaceTables();
      bindPlaceForms();
      bindAwaiting();
      bindGeocodingKey();
      on('#btnExport', 'click', function () {
        API.download('/admin/restaurants/export.csv', {}, 'restaurants.csv').catch(function (e) { alert(e.message); });
      });
      on('#csvFile', 'change', function (ev) {
        pickedFile = ev.target.files[0] || null;
        var pm = document.getElementById('pickedMsg');
        if (pm) {
          pm.innerHTML = pickedFile
            ? 'Holding <b>' + esc(pickedFile.name) + '</b> — it stays chosen while you move around.'
            : 'No file chosen yet.';
        }
      });

      on('#btnImport', 'click', function () {
        var input = document.getElementById('csvFile');
        var f = (input && input.files[0]) || pickedFile;
        var msg = document.getElementById('impMsg');
        if (!f) { msg.textContent = 'Choose a file first.'; return; }
        pickedFile = f;
        msg.textContent = 'Reading…';

        // An .xlsx is read here rather than asking for a Save As → CSV before
        // every upload. That step gets forgotten, and then the list stops being
        // kept up to date — which is worse than a hundred lines of ZIP reader.
        var read = /\.xlsx$/i.test(f.name)
          ? f.arrayBuffer()
              .then(window.DRIVERS_XLSX.readWorkbook)
              .then(window.DRIVERS_XLSX.toCsv)
          : f.text();

        read.then(function (csv) {
          msg.textContent = 'Importing…';
          return API.importRestaurants(csv);
        }).then(function (out) {
          pickedFile = null;
          msg.innerHTML = '<b>' + out.added + ' added, ' + out.updated + ' already here.</b>'
            + (out.awaitingLocation ? '<br>' + out.awaitingLocation + ' still need a location — use <b>Find locations</b> above.' : '')
            + (out.problems.length ? '<br>' + out.problems.length + ' row(s) skipped:<br><span class="tiny">'
              + esc(out.problems.slice(0, 20).map(function (p) { return 'row ' + p.row + ': ' + p.error; }).join('; ')) + '</span>' : '');
          setTimeout(render, 1200);
        }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });
    });
  }

  function geocodingKeyCard(secrets) {
    var saved = secrets && secrets.geocoding === 'configured';
    return '<div class="card"><h2>Location lookup key</h2>'
      + (saved
        ? '<p class="ok-msg" style="margin:0 0 10px">✓ A key is saved. The server checked Secret Manager just now — this is not remembered in the browser.</p>'
        : '<p class="err" style="margin:0 0 10px">No key saved yet. The lookup will not run until one is.</p>')
      + '<p class="muted">Finding a restaurant uses two of Google\'s APIs, and it matters that the key can reach both. '
      + '<b>Places</b> answers "where is this business?" and returns the building itself — that is the precise one. '
      + '<b>Geocoding</b> answers "where is this address?" and is only used when Places finds nothing. '
      + 'Paste the key once. It is stored in Google Secret Manager, never in this site and never shown again.</p>'
      + '<p class="tiny">Create it at <b>APIs &amp; Services → Credentials → Create credentials → API key</b>. '
      + 'Under <b>API restrictions</b> tick <b>both</b> <b>Places API (New)</b> and <b>Geocoding API</b> — with only Geocoding ticked '
      + 'every restaurant falls back to a road or a suburb, which is the imprecision you are trying to avoid. '
      + 'Leave <b>Application restrictions</b> set to <b>None</b>: the lookup runs on the server, which has no fixed IP, '
      + 'and any other setting blocks it. Both APIs must also be switched on under <b>APIs &amp; Services → Enabled APIs</b>. '
      + 'Places costs more per lookup than Geocoding — check the current rate in the console\'s pricing page before running all of them.</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
      + '<input id="geoKey" type="password" autocomplete="off" placeholder="AIzaSy…" style="max-width:420px">'
      + '<button class="btn-outline btn-sm" id="btnGeoKey">' + (saved ? 'Replace key' : 'Save key') + '</button>'
      + '</div><p id="geoKeyMsg" class="tiny" style="margin-top:8px"></p>'
      + '</div>';
  }

  // A re-render replaces the whole panel, and with it the <input type="file">
  // and whatever was chosen in it — so picking a file and then touching
  // anything else silently threw the file away. It is kept here instead,
  // outside the render cycle, and the panel shows what is held.
  var pickedFile = null;

  // The lookup's own vocabulary, in words the office uses. "AREA_ONLY" tells
  // nobody anything; "a whole suburb" says exactly what is wrong with it.
  function confidenceLabel(c) {
    return {
      PRECISE: 'the building',
      BUSINESS_UNSURE: 'a business, different name',
      EXACT: 'the building',
      APPROXIMATE: 'the right road',
      AREA_ONLY: 'a whole suburb',
      NONE: 'nothing found',
    }[c] || c;
  }
  function confidencePill(c) {
    if (c === 'PRECISE' || c === 'EXACT') return 'ok';
    if (c === 'NONE' || c === 'AREA_ONLY') return 'bad';
    return 'warn';
  }

  // Restaurants the engine is ignoring, and the ways out — none of which is
  // "type in three thousand pairs of coordinates". Nothing in this list counts
  // towards any kilometre until it leaves it, which is why it sits at the top.
  function awaitingCard(awaiting, counts) {
    if (!counts.total) return '';

    return '<div class="card" style="border-color:#efdcb2">'
      + '<h2>' + counts.total + ' restaurant(s) without a confirmed location</h2>'
      + '<div class="banner">These are <b>not</b> on the map and are <b>not</b> counted in any driver\'s kilometres. '
      + 'Anything found precisely — the business at its own building, under your own name for it — went straight onto the map and is not listed here. '
      + 'What is left is what the lookup could not settle on its own.</div>'

      // Step 1 — the lookup.
      + (counts.pending
        ? '<p style="margin:14px 0"><button class="btn-primary" id="btnLocate" style="width:auto;font-size:1rem;padding:12px 22px">'
          + 'Find locations for ' + counts.pending + ' restaurant' + (counts.pending === 1 ? '' : 's') + '</button> '
          + '<button class="btn-outline btn-sm" id="btnLocateStop" hidden>Stop</button></p>'
          + '<p id="locMsg" class="tiny" style="margin:0 0 6px"></p>'
        : '<p class="muted">Every one of these has been looked up already — they need a decision, not another lookup.</p>')

      // The lookup itself got better after the first run, so the rows it held
      // then deserve another go before anybody starts clicking through them.
      + (counts.unconfirmed
        ? '<p style="margin:10px 0 0"><button class="btn-outline btn-sm" id="btnRetry">'
          + 'Look up the ' + counts.unconfirmed + ' held row' + (counts.unconfirmed === 1 ? '' : 's') + ' again</button> '
          + '<span class="tiny">Use this after enabling Places on the key: it asks for the business by name, '
          + 'which finds the building where an address lookup could only find the road. Pins you have already placed are untouched.</span>'
          + '<span id="retryMsg" class="tiny"></span></p>'
        : '')

      // Step 2 — the two bulk decisions. They are separate buttons because
      // they are separate risks, and rolling them into one "accept all" would
      // hide the difference behind a number.
      + ((counts.business || counts.street)
        ? '<div style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px">'
          + (counts.business
            ? '<p style="margin:0 0 4px"><button class="btn-primary" id="btnAcceptBusiness" style="width:auto;font-size:1rem;padding:12px 22px">'
              + 'Accept ' + counts.business + ' business match' + (counts.business === 1 ? '' : 'es') + '</button></p>'
              + '<p class="tiny" style="margin:0 0 14px">A real restaurant was found at its own building — precise — but Google names it '
              + 'differently from your file (it found "Sai Restaurant" where you wrote "Sai Palace"). '
              + 'Usually the same shop written another way; occasionally the one next door. '
              + 'The table below shows each name, so you can scan them first.</p>'
            : '')
          + (counts.street
            ? '<p style="margin:0 0 4px"><button class="btn-outline" id="btnAcceptStreet" style="width:auto;font-size:1rem;padding:12px 22px">'
              + 'Accept ' + counts.street + ' street-level match' + (counts.street === 1 ? '' : 'es') + '</button></p>'
              + '<p class="tiny" style="margin:0">No business was found, so these came from the address in your spreadsheet and landed on the '
              + 'right road or block — tens of metres out at worst. A driver standing there is genuinely at that customer.</p>'
            : '')
          + '<p id="accMsg" class="tiny" style="margin:8px 0 0"></p></div>'
        : '')

      // Step 3 — what is genuinely left for a person, and how few it is.
      + (counts.areaOnly || counts.notFound
        ? '<p class="muted" style="margin-top:14px">'
          + (counts.areaOnly
            ? '<b>' + counts.areaOnly + '</b> only matched a whole suburb. Those are kilometres wide, so they are never accepted in bulk — '
              + 'the map would geofence half of Pune. Place them with <b>Pick on map</b>, or add a street address to the spreadsheet and re-import. '
            : '')
          + (counts.notFound ? '<b>' + counts.notFound + '</b> could not be found at all.' : '')
          + '</p>'
        : '')

      + '<div style="overflow-x:auto;max-height:420px;overflow-y:auto;margin-top:10px"><table><thead><tr>'
      + '<th>Your name for it</th><th>Area</th><th>What was found</th><th>Precision</th><th>Place it</th>'
      + '</tr></thead><tbody>'
      + awaiting.map(function (p) {
        var g = p.geocode || {};
        var c = p.candidate || null;
        return '<tr>'
          + '<td><b>' + esc(p.name) + '</b>' + (p.address ? '<br><span class="tiny">' + esc(p.address) + '</span>' : '') + '</td>'
          + '<td>' + esc(p.area || '—') + '</td>'
          // The business name is the whole decision for a person scanning this
          // list, so it leads, in the same weight as their own name above.
          + '<td>' + (g.displayName ? '<b>' + esc(g.displayName) + '</b><br>' : '')
          + (g.formattedAddress ? '<span class="tiny">' + esc(g.formattedAddress) + '</span>' : (g.displayName ? '' : '<span class="tiny">not looked up yet</span>'))
          + (g.alternatives ? '<br><span class="tiny">' + g.alternatives + ' other possible match(es)</span>' : '') + '</td>'
          + '<td>' + (g.confidence ? '<span class="pill ' + confidencePill(g.confidence) + '">' + esc(confidenceLabel(g.confidence)) + '</span>' : '—') + '</td>'
          + '<td style="white-space:nowrap">'
          + (c ? '<button class="btn-outline btn-sm confirm-cand" data-id="' + esc(p.id) + '">Use this</button> ' : '')
          // Clicking a map is the only sane way to place a pin by hand. Typing
          // latitude and longitude is not a fallback anybody actually uses.
          + '<button class="btn-outline btn-sm pick-map" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '"'
          + (c ? ' data-lat="' + c.lat + '" data-lng="' + c.lng + '"' : '') + '>Pick on map</button>'
          + '</td></tr>';
      }).join('')
      + '</tbody></table></div>'
      + (counts.total > awaiting.length
        ? '<p class="tiny">Showing ' + awaiting.length + ' of ' + counts.total
          + ', the ones a person can act on first. The buttons above work on all of them.</p>'
        : '')
      + '</div>';
  }

  /* Placing one pin by hand.
   *
   * The office was being asked to type a latitude and a longitude, which is not
   * something anybody can do for a restaurant they know by name — they would
   * have to go and look it up somewhere else and copy two numbers across. So
   * this opens the map at the geocoder's best guess and asks for a click.
   */
  function pickOnMap(id, name, lat, lng) {
    var start = (isFinite(lat) && isFinite(lng) && lat) ? [lng, lat] : null;
    modal('<h3 style="margin:0 0 4px">Where is ' + esc(name) + '?</h3>'
      + '<p class="tiny" style="margin:0 0 10px">Click the building on the map. '
      + (start
        ? 'The pin starts at the geocoder\'s best guess — drag or click to correct it.'
        : 'Nothing was found for this one, so start by finding the area.')
      + '</p>'
      + '<div id="pickMap" style="width:100%;height:420px;border-radius:12px;border:1px solid var(--line);background:#e3e6ef"></div>'
      + '<p id="pickMsg" class="tiny" style="margin:10px 0 12px">No point chosen yet.</p>'
      + '<button class="btn-primary" id="pickSave" style="width:auto" disabled>Save this location</button> '
      + '<button class="btn-outline" id="pickCancel" style="width:auto">Cancel</button>');

    var root = document.getElementById('modal');
    var chosen = start ? { lat: lat, lng: lng } : null;
    var saveBtn = document.getElementById('pickSave');
    var msg = document.getElementById('pickMsg');

    function show() {
      msg.innerHTML = chosen
        ? 'Chosen: <b>' + chosen.lat.toFixed(5) + ', ' + chosen.lng.toFixed(5) + '</b>'
        : 'No point chosen yet.';
      saveBtn.disabled = !chosen;
    }
    show();

    // The modal has only just been written into the page; MapLibre needs the
    // container to have a size before it measures itself.
    setTimeout(function () {
      var m = MAPS.create('pickMap', { center: start || undefined, zoom: start ? 16 : 11 });
      if (!m) { msg.innerHTML = '<span class="err">The map could not be loaded.</span>'; return; }
      var marker = null;
      function place(lngLat) {
        chosen = { lat: lngLat.lat, lng: lngLat.lng };
        if (marker) marker.setLngLat(lngLat);
        else marker = new maplibregl.Marker({ color: '#D7262F', draggable: true }).setLngLat(lngLat).addTo(m);
        marker.on('dragend', function () { place(marker.getLngLat()); });
        show();
      }
      if (start) place({ lng: start[0], lat: start[1] });
      m.on('click', function (e) { place(e.lngLat); });
    }, 60);

    on('#pickCancel', 'click', closeModal, root);
    on('#pickSave', 'click', function () {
      if (!chosen) return;
      saveBtn.disabled = true;
      API.confirmLocation(id, chosen.lat, chosen.lng)
        .then(function () { closeModal(); render(); })
        .catch(function (e) { saveBtn.disabled = false; msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    }, root);
  }

  function bindGeocodingKey() {
    on('#btnGeoKey', 'click', function () {
      var v = (document.getElementById('geoKey').value || '').trim();
      var m = document.getElementById('geoKeyMsg');
      if (!v) { m.innerHTML = '<span class="err">Paste the key first.</span>'; return; }
      m.textContent = 'Saving…';
      API.setIntegrationSecret('geocoding', v).then(function () {
        document.getElementById('geoKey').value = '';
        m.innerHTML = '<span class="ok-msg">Saved. Import your restaurants, then use Find locations.</span>';
      }).catch(function (e) { m.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
    });
  }

  function bindAwaiting() {
    // Keeps going by itself. The server does 200 at a time because a thousand
    // lookups do not fit in one request, but making somebody click sixteen
    // times is not a design — so this repeats until nothing is pending, shows a
    // running total, and stops the moment anything goes wrong rather than
    // hammering a failing API.
    on('#btnLocate', 'click', function () {
      var msg = document.getElementById('locMsg');
      var btn = document.getElementById('btnLocate');
      var stopBtn = document.getElementById('btnLocateStop');
      var placed = 0, precise = 0, held = 0, missing = 0, stop = false;
      var advisory = '';
      btn.disabled = true;
      stopBtn.hidden = false;
      stopBtn.onclick = function () { stop = true; stopBtn.textContent = 'Stopping…'; };

      function tally() {
        return '<b>' + placed + ' placed</b>'
          + (precise ? ' (' + precise + ' on the building itself)' : '')
          + ', ' + held + ' need checking, ' + missing + ' not found.';
      }

      function done(extra) {
        btn.disabled = false;
        stopBtn.hidden = true;
        stopBtn.textContent = 'Stop';
        msg.innerHTML = (extra || '') + ' ' + tally() + advisory;
        setTimeout(render, 1800);
      }

      function round() {
        msg.innerHTML = 'Looking up… ' + tally() + advisory;
        API.locateRestaurants(200).then(function (out) {
          placed += out.placed; precise += (out.precise || 0);
          held += out.heldForReview; missing += out.notFound;

          // A key without Places access is a warning, not a reason to stop —
          // the run carries on using addresses, just far less precisely.
          var fatal = (out.failures || []).filter(function (f) { return !f.advisory; });
          var advice = (out.failures || []).filter(function (f) { return f.advisory; });
          if (advice.length && !advisory) {
            advisory = '<br><span class="err">' + esc(advice[0].error) + '</span>';
          }
          if (fatal.length) return done('<span class="err">Stopped: ' + esc(fatal[0].error) + '.</span>');
          if (stop) return done('Stopped.');
          if (out.stillPending > 0 && out.looked > 0) return round();
          return done('Finished.');
        }).catch(function (e) {
          done('<span class="err">' + esc(
            e.code === 'NO_GEOCODING_KEY'
              ? 'No lookup key saved yet — add one in the Location lookup key card at the top.'
              : e.message) + '</span>');
        });
      }
      round();
    });

    // The two bulk accepts. Each loops, because the server does a thousand at
    // a time, and says plainly how many went on the map.
    function bulkAccept(buttonId, kind) {
      on('#' + buttonId, 'click', function () {
        var btn = document.getElementById(buttonId);
        var msg = document.getElementById('accMsg');
        var total = 0;
        btn.disabled = true;

        function round() {
          msg.innerHTML = 'Placing… <b>' + total + '</b> so far.';
          API.acceptCandidates(kind, 1000).then(function (out) {
            total += out.accepted;
            if (out.remaining > 0 && out.accepted > 0) return round();
            msg.innerHTML = '<span class="ok-msg"><b>' + total + '</b> restaurant(s) are now on the map.</span>';
            setTimeout(render, 1500);
            return null;
          }).catch(function (e) {
            btn.disabled = false;
            msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
          });
        }
        round();
      });
    }
    bulkAccept('btnAcceptBusiness', 'business');
    bulkAccept('btnAcceptStreet', 'street');

    on('#btnRetry', 'click', function () {
      var btn = document.getElementById('btnRetry');
      var msg = document.getElementById('retryMsg');
      btn.disabled = true;
      msg.textContent = ' Queueing…';
      API.retryUnconfirmed().then(function (out) {
        msg.innerHTML = ' <span class="ok-msg">' + out.queued + ' queued — run Find locations above.</span>';
        setTimeout(render, 1200);
      }).catch(function (e) {
        btn.disabled = false;
        msg.innerHTML = ' <span class="err">' + esc(e.message) + '</span>';
      });
    });

    document.querySelectorAll('.confirm-cand').forEach(function (b) {
      b.addEventListener('click', function () {
        API.confirmLocation(b.getAttribute('data-id'), null, null)
          .then(render).catch(function (e) { alert(e.message); });
      });
    });
    document.querySelectorAll('.pick-map').forEach(function (b) {
      b.addEventListener('click', function () {
        pickOnMap(
          b.getAttribute('data-id'),
          b.getAttribute('data-name'),
          Number(b.getAttribute('data-lat')),
          Number(b.getAttribute('data-lng')),
        );
      });
    });
  }

  // A just-imported restaurant has no coordinates yet. That is the normal state
  // of every row the office uploads, not an error, so the table has to say so
  // rather than assume a pin is there.
  function hasPin(p) {
    return typeof p.lat === 'number' && isFinite(p.lat) && typeof p.lng === 'number' && isFinite(p.lng);
  }

  // The office's own export is over three thousand rows. Drawing them all at
  // once locks the browser up, so a page is drawn at a time — and the search
  // box runs over the whole list, not just over what is on screen.
  var PLACE_PAGE = 200;
  var placeCache = {};
  var placeShown = {};

  function placeTable(list, kind) {
    placeCache[kind] = list;
    placeShown[kind] = PLACE_PAGE;
    if (!list.length) return '<p class="muted">None yet.</p>';
    return (list.length > PLACE_PAGE
      ? '<input class="place-search" data-kind="' + kind + '" placeholder="Search by name, area or customer ID" style="max-width:360px;margin-bottom:10px">'
      : '')
      + '<div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Customer ID</th><th>Area</th><th>Coordinates</th><th>Geofence</th><th>Status</th><th></th></tr></thead>'
      + '<tbody data-placebody="' + kind + '"></tbody></table></div>'
      + '<p class="tiny" data-placefoot="' + kind + '"></p>';
  }

  function placeMatches(p, q) {
    if (!q) return true;
    return ((p.name || '') + ' ' + (p.area || '') + ' ' + (p.customerId || '') + ' ' + (p.address || ''))
      .toLowerCase().indexOf(q) !== -1;
  }

  function fillPlaceTable(kind, q) {
    var body = document.querySelector('[data-placebody="' + kind + '"]');
    var foot = document.querySelector('[data-placefoot="' + kind + '"]');
    if (!body) return;
    var all = (placeCache[kind] || []).filter(function (p) { return placeMatches(p, q); });
    var rows = all.slice(0, placeShown[kind]);
    body.innerHTML = rows.map(function (p) {
      return '<tr>'
        + '<td><b>' + esc(p.name) + '</b>' + (p.address ? '<br><span class="tiny">' + esc(p.address) + '</span>' : '') + '</td>'
        + '<td>' + esc(p.customerId || '—') + '</td>'
        + '<td>' + esc(p.area || '—') + '</td>'
        + '<td class="tiny">' + (hasPin(p)
          ? p.lat.toFixed(5) + ', ' + p.lng.toFixed(5)
          : '<span class="pill warn">no location yet</span>') + '</td>'
        + '<td>' + (p.radiusM ? p.radiusM + ' m' : 'default') + '</td>'
        + '<td><span class="pill ' + (p.active === false ? 'idle' : 'active') + '">' + (p.active === false ? 'inactive' : 'active') + '</span></td>'
        + '<td><button class="btn-outline btn-sm" data-editplace="' + esc(p.id) + '" data-kind="' + kind + '">Edit</button></td>'
        + '</tr>';
    }).join('');
    if (foot) {
      foot.innerHTML = all.length > rows.length
        ? 'Showing ' + rows.length + ' of ' + all.length + '. '
          + '<button class="link-sm" data-placemore="' + kind + '">Show ' + Math.min(PLACE_PAGE, all.length - rows.length) + ' more</button>'
        : (all.length ? all.length + ' shown.' : 'Nothing matches that search.');
      var more = foot.querySelector('[data-placemore]');
      if (more) {
        more.addEventListener('click', function () {
          placeShown[kind] += PLACE_PAGE;
          var input = document.querySelector('.place-search[data-kind="' + kind + '"]');
          fillPlaceTable(kind, input ? input.value.trim().toLowerCase() : '');
        });
      }
    }
  }

  function bindPlaceTables() {
    Object.keys(placeCache).forEach(function (kind) { fillPlaceTable(kind, ''); });
    document.querySelectorAll('.place-search').forEach(function (input) {
      input.addEventListener('input', function () {
        var kind = input.getAttribute('data-kind');
        placeShown[kind] = PLACE_PAGE;
        fillPlaceTable(kind, input.value.trim().toLowerCase());
      });
    });
  }

  function placeForm(kind) {
    return '<details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600;font-size:.9rem">Add a ' + (kind === 'facilities' ? 'facility' : 'location') + '</summary>'
      + '<div style="margin-top:12px" data-form="' + kind + '">'
      + '<div class="row2"><div class="field"><label>Name</label><input data-f="name"></div>'
      + (kind === 'restaurants' ? '<div class="field"><label>Customer ID</label><input data-f="customerId" placeholder="matches the order system"></div>' : '<div class="field"><label>Area</label><input data-f="area"></div>')
      + '</div>'
      + '<div class="field"><label>Address</label><input data-f="address"></div>'
      + '<div class="row3"><div class="field"><label>Latitude</label><input data-f="lat" inputmode="decimal"></div>'
      + '<div class="field"><label>Longitude</label><input data-f="lng" inputmode="decimal"></div>'
      + '<div class="field"><label>Geofence radius (m)</label><input data-f="radiusM" inputmode="numeric" placeholder="' + (kind === 'facilities' ? '150' : '80') + '"></div></div>'
      + '<p class="err" data-err hidden></p>'
      + '<button class="btn-primary" data-save="' + kind + '">Save</button>'
      + '</div></details>';
  }

  function bindPlaceForms() {
    on('[data-save]', 'click', function (e) {
      var kind = e.currentTarget.dataset.save;
      var form = document.querySelector('[data-form="' + kind + '"]');
      var body = {};
      form.querySelectorAll('[data-f]').forEach(function (el) {
        var v = el.value.trim();
        if (!v) return;
        body[el.dataset.f] = ['lat', 'lng', 'radiusM'].indexOf(el.dataset.f) !== -1 ? Number(v) : v;
      });
      var err = form.querySelector('[data-err]');
      err.hidden = true;
      API.createPlace(kind, body).then(render).catch(function (ex) { err.textContent = ex.message; err.hidden = false; });
    });
    // Delegated: the rows are drawn a page at a time, so the buttons do not all
    // exist when this runs.
    view().addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-editplace]') : null;
      if (!btn) return;
      var id = btn.dataset.editplace;
      var kind = btn.dataset.kind;
      API.places(kind).then(function (list) {
        var p = list.find(function (x) { return x.id === id; });
        modal('<h3>Edit ' + esc(p.name) + '</h3>'
          + '<div class="field"><label>Name</label><input id="eName" value="' + esc(p.name) + '"></div>'
          + (kind === 'restaurants' ? '<div class="field"><label>Customer ID</label><input id="eCust" value="' + esc(p.customerId || '') + '"></div>' : '')
          + '<div class="field"><label>Address</label><input id="eAddr" value="' + esc(p.address || '') + '"></div>'
          + '<div class="row3"><div class="field"><label>Latitude</label><input id="eLat" inputmode="decimal" value="' + (hasPin(p) ? p.lat : '') + '"></div>'
          + '<div class="field"><label>Longitude</label><input id="eLng" inputmode="decimal" value="' + (hasPin(p) ? p.lng : '') + '"></div>'
          + '<div class="field"><label>Radius (m)</label><input id="eRad" value="' + (p.radiusM || '') + '"></div></div>'
          + '<div class="field"><label>Active</label><select id="eActive"><option value="1"' + (p.active !== false ? ' selected' : '') + '>Active</option><option value="0"' + (p.active === false ? ' selected' : '') + '>Inactive</option></select></div>'
          + '<p class="tiny">Changing a geofence does not change any ride already calculated. Recalculate from Settings if you want past days reworked with the new radius.</p>'
          + '<p id="eErr" class="err" hidden></p>'
          + '<button class="btn-primary" id="eSave">Save</button> <button class="btn-outline" id="eCancel">Cancel</button>');
        var root = document.getElementById('modal');
        on('#eCancel', 'click', closeModal, root);
        on('#eSave', 'click', function () {
          var body = {
            name: document.getElementById('eName').value.trim(),
            address: document.getElementById('eAddr').value.trim() || null,
            lat: Number(document.getElementById('eLat').value),
            lng: Number(document.getElementById('eLng').value),
            radiusM: document.getElementById('eRad').value ? Number(document.getElementById('eRad').value) : null,
            active: document.getElementById('eActive').value === '1',
          };
          if (kind === 'restaurants') body.customerId = document.getElementById('eCust').value.trim() || null;
          API.updatePlace(kind, id, body).then(function () { closeModal(); render(); })
            .catch(function (ex) { var el = document.getElementById('eErr'); el.textContent = ex.message; el.hidden = false; });
        }, root);
      });
    });
  }

  // ── Deliveries / integration ───────────────────────────────────────────
  function renderOrders() {
    return Promise.all([API.sources(), API.orders({})]).then(function (r) {
      var s = r[0];
      var orders = r[1];
      set('<div class="card"><h2>Order sources</h2>'
        + '<table><thead><tr><th>Source</th><th>What it is</th><th>Status</th><th></th></tr></thead><tbody>'
        + s.sources.map(function (src) {
          return '<tr><td><b>' + esc(src.name) + '</b></td><td class="tiny">' + esc(src.description) + '</td>'
            + '<td>' + (src.configured ? '<span class="pill live">ready</span>' : '<span class="pill warn">not configured</span>') + '</td>'
            + '<td>' + (src.name !== 'manual' ? '<button class="btn-outline btn-sm" data-sync="' + esc(src.name) + '"' + (src.configured ? '' : ' disabled') + '>Sync today</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>'
        + '<p class="tiny" style="margin-top:10px">Order records are what raise a restaurant visit from <b>likely</b> to <b>verified</b>. Without them most visits stay at MEDIUM confidence — that is the honest ceiling, not a bug.</p>'
        + '</div>'

        + '<div class="card"><h2>Import orders (CSV)</h2>'
        + '<p class="muted">Columns: <code>order_id, customer_id, driver_code, ordered_at, window_start, window_end, delivered_at, status, lat, lng</code>. Times without a timezone are read as IST.</p>'
        + '<input type="file" id="ordFile" accept=".csv,text/csv" style="margin-bottom:10px">'
        + '<div><button class="btn-primary" id="btnOrdImport">Import</button></div>'
        + '<p id="ordMsg" class="muted" style="margin-top:10px"></p></div>'

        + '<div class="card"><h2>Recent orders (' + orders.length + ')</h2>'
        + (orders.length ? '<div style="overflow-x:auto"><table><thead><tr><th>Order</th><th>Customer</th><th>Driver</th><th>Ordered</th><th>Window</th><th>Status</th><th>Source</th></tr></thead><tbody>'
          + orders.slice(0, 200).map(function (o) {
            return '<tr><td>' + esc(o.externalId || o.id) + '</td><td>' + esc(o.customerId || '—') + '</td>'
              + '<td>' + esc(o.assignedDriverId ? o.assignedDriverId.slice(0, 8) : '—') + '</td>'
              + '<td>' + dateTime(o.orderedAt) + '</td>'
              + '<td class="tiny">' + (o.windowStart ? time(o.windowStart) + '–' + time(o.windowEnd) : '—') + '</td>'
              + '<td>' + esc(o.status || '—') + '</td><td>' + esc(o.source) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          : '<p class="muted">No order records yet. Until there are, delivery matching has nothing to match against and every visit is reported as an unmatched visit.</p>')
        + '</div>'

        + '<div class="card"><h2>Integration log</h2>'
        + (s.recentLogs.length ? '<table><thead><tr><th>When</th><th>Source</th><th>Operation</th><th>Result</th></tr></thead><tbody>'
          + s.recentLogs.map(function (l) {
            return '<tr><td>' + dateTime(l.at) + '</td><td>' + esc(l.source) + '</td><td>' + esc(l.op) + '</td>'
              + '<td>' + (l.ok ? '<span class="pill live">' + (l.count || 0) + ' records</span>' : '<span class="pill bad">' + esc(l.error || 'failed') + '</span>') + '</td></tr>';
          }).join('') + '</tbody></table>' : '<p class="muted">No syncs yet.</p>')
        + '</div>');

      on('[data-sync]', 'click', function (e) {
        var src = e.currentTarget.dataset.sync;
        e.currentTarget.disabled = true;
        API.syncOrders(src, {}).then(function (out) { alert(out.imported + ' order(s) imported.'); render(); })
          .catch(function (ex) { alert(ex.message); render(); });
      });
      on('#btnOrdImport', 'click', function () {
        var f = document.getElementById('ordFile').files[0];
        var msg = document.getElementById('ordMsg');
        if (!f) { msg.textContent = 'Choose a CSV file first.'; return; }
        msg.textContent = 'Importing…';
        f.text().then(function (csv) { return API.importOrders(csv); }).then(function (out) {
          msg.innerHTML = '<b>' + out.imported + ' order(s) imported.</b>'
            + (out.rejected.length ? '<br>' + out.rejected.length + ' rejected: <span class="tiny">' + esc(out.rejected.slice(0, 10).map(function (x) { return (x.externalId || '?') + ': ' + x.problems.join(', '); }).join('; ')) + '</span>' : '')
            + (out.parseProblems && out.parseProblems.length ? '<br><span class="tiny">' + esc(out.parseProblems.slice(0, 10).join('; ')) + '</span>' : '');
          setTimeout(render, 1500);
        }).catch(function (ex) { msg.innerHTML = '<span class="err">' + esc(ex.message) + '</span>'; });
      });
    });
  }

  // ── Reports ────────────────────────────────────────────────────────────
  var REPORT_LIST = [
    ['driver_distance', 'Driver distance (daily / weekly / monthly)'],
    ['business_km', 'Modern Dairy business kilometres'],
    ['restaurant_visits', 'Restaurant visits'],
    ['delivery_matching', 'Delivery matching'],
    ['gps_reliability', 'GPS tracking reliability'],
    ['route_anomaly', 'Route anomalies'],
    ['classification_audit', 'Manual classification audit'],
  ];

  function renderReports() {
    var from = todayISO();
    return API.drivers(true).then(function (drivers) {
      set('<div class="card"><h2>Report</h2>'
        + '<div class="bar">'
        + '<div style="min-width:260px"><label for="rName">Report</label><select id="rName">'
        + REPORT_LIST.map(function (x) { return '<option value="' + x[0] + '">' + esc(x[1]) + '</option>'; }).join('') + '</select></div>'
        + '<div><label for="rFrom">From</label><input id="rFrom" type="date" value="' + from + '"></div>'
        + '<div><label for="rTo">To</label><input id="rTo" type="date" value="' + from + '"></div>'
        + '<div><label for="rDriver">Driver</label><select id="rDriver"><option value="">All drivers</option>'
        + drivers.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.driverCode + ' — ' + d.name) + '</option>'; }).join('') + '</select></div>'
        + '<div><label for="rConf">Confidence</label><select id="rConf"><option value="">Any</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option><option>UNKNOWN</option></select></div>'
        + '<div><label for="rQual">GPS quality</label><select id="rQual"><option value="">Any</option><option>good</option><option>fair</option><option>poor</option><option>no_data</option></select></div>'
        + '<div><button class="btn-primary" id="btnRun">Run</button></div>'
        + '<div><button class="btn-outline" id="btnCsv">CSV</button></div>'
        + '<div><button class="btn-outline" id="btnXls">Excel</button></div>'
        + '<div><button class="btn-outline" id="btnPrint">Print</button></div>'
        + '</div></div>'
        + '<div id="reportOut"></div>');

      on('#btnRun', 'click', runReport);
      on('#btnCsv', 'click', function () { exportReport('csv'); });
      on('#btnXls', 'click', function () { exportReport('xls'); });
      on('#btnPrint', 'click', function () { window.print(); });
      runReport();
    });
  }

  function reportParams() {
    var f = document.getElementById('rFrom').value;
    var t = document.getElementById('rTo').value;
    return {
      from: f ? Date.parse(f + 'T00:00:00') : undefined,
      to: t ? Date.parse(t + 'T23:59:59') : undefined,
      driverId: document.getElementById('rDriver').value || undefined,
      confidence: document.getElementById('rConf').value || undefined,
      quality: document.getElementById('rQual').value || undefined,
    };
  }

  function runReport() {
    var name = document.getElementById('rName').value;
    var out = document.getElementById('reportOut');
    out.innerHTML = spinner('Running…');
    API.report(name, reportParams()).then(function (r) {
      var sum = r.meta.summary;
      out.innerHTML = '<div class="card"><h2>' + esc(r.meta.title) + '</h2>'
        + (r.meta.note ? '<div class="banner">' + esc(r.meta.note) + '</div>' : '')
        + '<div class="grid metrics" style="margin-bottom:12px">'
        + metric(sum.rides, 'Rides')
        + metric(km(sum.km.verifiedBusiness), 'Verified business', 'ok')
        + metric(km(sum.km.likelyBusiness), 'Likely business', 'warn')
        + metric(km(sum.km.personal), 'Personal')
        + metric(km(sum.km.unknown), 'Unknown', sum.km.unknown ? 'warn' : '')
        + metric(km(sum.km.dayTotal), 'Total tracked')
        + metric(sum.visits, 'Restaurant visits')
        + metric(sum.pendingReview, 'Needs review', sum.pendingReview ? 'warn' : '')
        + '</div>'
        + '<div style="overflow-x:auto">' + tableFrom(r.columns, r.rows) + '</div>'
        + '<p class="tiny" style="margin-top:10px">' + r.rows.length + ' row(s). Verified business distance counts HIGH-confidence segments only; everything less certain is shown in its own column and never folded in.</p>'
        + '</div>';
    }).catch(function (e) { out.innerHTML = errBox(e); });
  }

  function tableFrom(columns, rows) {
    if (!rows.length) return '<p class="muted">No rows for this period.</p>';
    return '<table><thead><tr>' + columns.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + rows.slice(0, 500).map(function (r) {
        return '<tr>' + columns.map(function (c) { return '<td>' + esc(r[c.key]) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  function exportReport(format) {
    var name = document.getElementById('rName').value;
    var params = reportParams();
    params.format = format;
    API.download('/admin/reports/' + name, params, name + '.' + (format === 'xls' ? 'xls' : 'csv'))
      .catch(function (e) { alert(e.message); });
  }

  // ── Alerts ─────────────────────────────────────────────────────────────
  function renderAlerts() {
    return Promise.all([API.alerts('open'), API.events()]).then(function (r) {
      var alerts = r[0];
      var events = r[1];
      set('<div class="card"><h2>Open alerts (' + alerts.length + ')</h2>'
        + (alerts.length ? '<table><thead><tr><th>Raised</th><th>Alert</th><th>Detail</th><th>Severity</th><th>Seen</th><th></th></tr></thead><tbody>'
          + alerts.map(function (a) {
            return '<tr><td>' + dateTime(a.raisedAt) + '</td><td><b>' + esc(a.kind.replace(/_/g, ' ')) + '</b></td>'
              + '<td class="tiny">' + esc(a.detail) + '</td>'
              + '<td><span class="pill ' + (a.severity === 'critical' ? 'bad' : a.severity === 'warn' ? 'warn' : 'idle') + '">' + esc(a.severity) + '</span></td>'
              + '<td>' + (a.occurrences || 1) + '×</td>'
              + '<td><button class="btn-outline btn-sm" data-resolve="' + esc(a.id) + '">Resolve</button></td></tr>';
          }).join('') + '</tbody></table>'
          : '<p class="muted">Nothing needs attention.</p>')
        + '<p class="tiny" style="margin-top:10px">Alerts never contain coordinates. They say a driver\'s tracking has a problem, not where the driver is.</p></div>'

        + '<div class="card"><h2>Recent tracking events</h2>'
        + '<table><thead><tr><th>When</th><th>Driver</th><th>Event</th><th>Detail</th></tr></thead><tbody>'
        + events.slice(0, 100).map(function (ev) {
          return '<tr><td>' + dateTime(ev.at) + '</td><td class="tiny">' + esc((ev.driverId || '—').slice(0, 8)) + '</td>'
            + '<td>' + esc(ev.kind.replace(/_/g, ' ')) + '</td>'
            + '<td class="tiny">' + esc(ev.detail ? JSON.stringify(ev.detail).slice(0, 160) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>');

      on('[data-resolve]', 'click', function (e) {
        var note = prompt('Note (optional) — what did you do about it?');
        if (note === null) return;
        API.resolveAlert(e.currentTarget.dataset.resolve, note).then(render).catch(function (ex) { alert(ex.message); });
      });
    });
  }

  // ── Settings ───────────────────────────────────────────────────────────
  function renderSettings() {
    return Promise.all([API.config(), API.audit()]).then(function (r) {
      var c = r[0];
      var audit = r[1];
      var keys = Object.keys(c.defaults).filter(function (k) { return k !== 'retention'; });
      set('<div class="card"><h2>Processing thresholds</h2>'
        + '<p class="muted">These decide what the system concludes. Changing one does <b>not</b> change any ride already calculated — use Recalculate below for that. Every change is audit-logged, and the thresholds used are stored on each result.</p>'
        + (c.rejected && c.rejected.length ? '<div class="banner">Ignored: ' + esc(c.rejected.map(function (x) { return x.key + ' (' + x.reason + ')'; }).join(', ')) + '</div>' : '')
        + '<div style="overflow-x:auto"><table><thead><tr><th>Setting</th><th>Value</th><th>Default</th><th>Allowed range</th></tr></thead><tbody>'
        + keys.map(function (k) {
          var range = c.ranges[k];
          return '<tr><td>' + esc(k) + '</td>'
            + '<td><input data-cfg="' + esc(k) + '" value="' + esc(String(c.config[k])) + '" style="max-width:120px"></td>'
            + '<td class="tiny">' + esc(String(c.defaults[k])) + '</td>'
            + '<td class="tiny">' + (range ? range[0] + ' – ' + range[1] : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        + '<div class="row3" style="margin-top:12px">'
        + Object.keys(c.defaults.retention).map(function (k) {
          return '<div class="field"><label>retention.' + esc(k) + ' (days)</label><input data-ret="' + esc(k) + '" value="' + esc(String(c.config.retention[k])) + '"></div>';
        }).join('') + '</div>'
        + '<p id="cfgMsg" class="muted"></p>'
        + '<button class="btn-primary" id="btnSaveCfg">Save thresholds</button>'
        + '<p class="tiny" style="margin-top:8px">Calculation version <b>' + esc(c.calcVersion) + '</b>.</p>'
        + '</div>'

        + '<div class="card"><h2>Recalculate</h2>'
        + '<p class="muted">Re-runs the whole calculation over the raw GPS for a date range. Raw points are never modified; the processed result is replaced with a new versioned one.</p>'
        + '<div class="bar"><div><label>From</label><input id="pFrom" type="date" value="' + todayISO() + '"></div>'
        + '<div><label>To</label><input id="pTo" type="date" value="' + todayISO() + '"></div>'
        + '<div><button class="btn-primary" id="btnReprocess">Recalculate</button></div>'
        + '<div><button class="btn-outline" id="btnMaint">Run maintenance pass</button></div></div>'
        + '<p id="pMsg" class="muted"></p></div>'

        + '<div class="card"><h2>Admin audit log</h2>'
        + '<div style="overflow-x:auto"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>'
        + audit.slice(0, 100).map(function (a) {
          return '<tr><td>' + dateTime(a.at) + '</td><td class="tiny">' + esc(a.adminId) + '</td><td>' + esc(a.action) + '</td>'
            + '<td class="tiny">' + esc(String(a.target || '').slice(0, 40)) + '</td>'
            + '<td class="tiny">' + esc(a.after ? JSON.stringify(a.after).slice(0, 140) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>');

      on('#btnSaveCfg', 'click', function () {
        var overrides = {};
        view().querySelectorAll('[data-cfg]').forEach(function (el) {
          var v = Number(el.value);
          if (Number.isFinite(v) && v !== c.defaults[el.dataset.cfg]) overrides[el.dataset.cfg] = v;
        });
        var ret = {};
        view().querySelectorAll('[data-ret]').forEach(function (el) {
          var v = Number(el.value);
          if (Number.isFinite(v)) ret[el.dataset.ret] = v;
        });
        overrides.retention = ret;
        var msg = document.getElementById('cfgMsg');
        msg.textContent = 'Saving…';
        API.saveConfig(overrides).then(function (out) {
          msg.innerHTML = '<span class="ok-msg">Saved. ' + esc(out.note) + '</span>'
            + (out.rejected.length ? '<br><span class="err">Ignored: ' + esc(out.rejected.map(function (x) { return x.key + ' (' + x.reason + ')'; }).join(', ')) + '</span>' : '');
        }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });

      on('#btnReprocess', 'click', function () {
        var msg = document.getElementById('pMsg');
        msg.textContent = 'Recalculating…';
        API.processRange({
          from: Date.parse(document.getElementById('pFrom').value + 'T00:00:00'),
          to: Date.parse(document.getElementById('pTo').value + 'T23:59:59'),
        }).then(function (out) {
          msg.innerHTML = '<span class="ok-msg">' + out.processed + ' ride(s) recalculated.</span>'
            + (out.failed.length ? '<br><span class="err">' + out.failed.length + ' failed: ' + esc(out.failed.map(function (f) { return f.error; }).join('; ')) + '</span>' : '');
        }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });

      on('#btnMaint', 'click', function () {
        var msg = document.getElementById('pMsg');
        msg.textContent = 'Running…';
        API.runMaintenance(true).then(function (out) {
          msg.innerHTML = '<span class="ok-msg">Done.</span> <span class="tiny">'
            + esc(JSON.stringify({ autoClosed: out.autoClosed, alerts: out.alerts, processing: out.processing, retention: out.retention, errors: out.errors })) + '</span>';
        }).catch(function (e) { msg.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      });
    });
  }

  return { renderTabs: renderTabs, render: render, go: go, state: state };
})();
