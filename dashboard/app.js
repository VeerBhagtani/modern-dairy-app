/* Modern Drivers dashboard — sign-in and bootstrap.
 *
 * The office signs in with a username and password held by this product's own
 * backend. No Google account, no Firebase, nothing shared with any other
 * system: one admin user is created at setup and that is the whole identity
 * story.
 *
 * The token lives in sessionStorage, so closing the tab signs you out. A screen
 * showing forty people's live positions should not stay open on an office PC
 * overnight.
 */
(function () {
  'use strict';

  var KEY = 'md_admin_session';
  var el = function (id) { return document.getElementById(id); };

  var session = null;
  try {
    session = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  } catch (e) { session = null; }

  // The API layer asks for this on every request.
  window.DRIVERS_AUTH = {
    getToken: function () {
      if (!session || !session.token) return Promise.reject(new Error('Not signed in.'));
      return Promise.resolve(session.token);
    },
    admin: function () { return session && session.admin; },
    signOut: signOut,
  };

  function signOut() {
    session = null;
    try { sessionStorage.removeItem(KEY); } catch (e) { /* private window */ }
    showLogin();
  }
  // An expired or rejected token anywhere in the app lands back here.
  window.DRIVERS_SIGNOUT = signOut;

  function showLogin(message) {
    el('login').hidden = false;
    el('app').hidden = true;
    var err = el('loginErr');
    err.hidden = !message;
    err.textContent = message || '';
    var u = el('username');
    if (u) u.focus();
  }

  function showApp() {
    el('login').hidden = true;
    el('app').hidden = false;
    var who = el('whoami');
    if (who && session && session.admin) {
      who.textContent = session.admin.name + ' · ' + session.admin.role;
    }
    if (!window.DRIVERS_API.base) {
      el('tabs').innerHTML = '';
      el('view').innerHTML = '<div class="card"><p class="err">This dashboard has no server address yet.</p>'
        + '<p class="muted">Set <code>API_BASE</code> in <code>dashboard/config.js</code> and deploy again. '
        + 'Nothing will load until then — the dashboard will not invent numbers to fill the screen.</p></div>';
      return;
    }
    window.DRIVERS_VIEWS.renderTabs();
    window.DRIVERS_VIEWS.render();
  }

  function signIn() {
    var username = el('username').value.trim();
    var password = el('password').value;
    var btn = el('btnLogin');
    var err = el('loginErr');
    err.hidden = true;
    if (!username || !password) {
      err.textContent = 'Enter your username and password.';
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    var base = String((window.DRIVERS_CONFIG || {}).API_BASE || '').replace(/\/+$/, '');
    if (!base) {
      err.textContent = 'This dashboard has no server address configured yet.';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Sign in';
      return;
    }

    fetch(base + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password }),
    })
      .then(function (r) { return r.json().catch(function () { return { success: false, message: 'Server error ' + r.status }; }); })
      .then(function (j) {
        if (!j || !j.success) throw new Error((j && j.message) || 'Sign-in failed.');
        session = { token: j.data.token, admin: j.data.admin };
        try { sessionStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private window */ }
        el('password').value = '';
        showApp();
      })
      .catch(function (e) {
        err.textContent = e.message === 'Failed to fetch'
          ? 'Could not reach the server. Check that it is deployed and running.'
          : e.message;
        err.hidden = false;
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
  }

  el('btnLogin').addEventListener('click', signIn);
  el('password').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });
  el('username').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('password').focus(); });
  el('btnSignout').addEventListener('click', signOut);

  function tick() {
    var c = el('clock');
    if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  setInterval(tick, 1000);
  tick();

  if (session && session.token) showApp(); else showLogin();
})();
