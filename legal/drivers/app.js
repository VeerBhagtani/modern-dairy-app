/* Modern Drivers dashboard — bootstrap and authentication.
 *
 * Firebase Auth is the identity. The backend verifies the resulting ID token
 * properly and checks the uid, so this dashboard holds no credential of its
 * own and there is one login for the whole admin surface.
 *
 * Persistence is in-memory only, exactly as the ordering admin panel does it:
 * closing the tab signs you out. A dashboard showing 40 people's live
 * locations should not stay signed in on a shared office PC.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeAuth, inMemoryPersistence, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const CFG = window.DRIVERS_CONFIG;
const app = initializeApp(CFG.firebase);
const auth = initializeAuth(app, { persistence: inMemoryPersistence });

// The API layer asks for a fresh ID token on every request; the SDK returns a
// cached one until it is close to expiry, so this is cheap.
window.DRIVERS_AUTH = {
  getToken() {
    const user = auth.currentUser;
    if (!user) return Promise.reject(new Error('Not signed in.'));
    return user.getIdToken();
  },
  user() { return auth.currentUser; },
};

const el = (id) => document.getElementById(id);

function showLogin(message) {
  el('login').hidden = false;
  el('app').hidden = true;
  const err = el('loginErr');
  err.hidden = !message;
  err.textContent = message || '';
}

el('btnLogin').addEventListener('click', () => {
  const email = el('email').value.trim();
  const password = el('password').value;
  el('btnLogin').disabled = true;
  el('loginErr').hidden = true;
  signInWithEmailAndPassword(auth, email, password)
    .catch(() => {
      // One message whatever the failure: a distinct "no such account" would
      // tell an attacker which addresses are real.
      showLogin('Sign-in failed. Check the email and password.');
    })
    .finally(() => { el('btnLogin').disabled = false; });
});
el('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btnLogin').click(); });
el('btnSignout').addEventListener('click', () => signOut(auth));

function tick() {
  el('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(tick, 1000);
tick();

onAuthStateChanged(auth, (user) => {
  if (user && user.uid !== CFG.ADMIN_UID) {
    // Signed in to Firebase, but not as the admin. Anonymous sessions and
    // customer accounts carry a uid too, so this check is what actually gates
    // the dashboard on the client side — and the backend repeats it.
    signOut(auth);
    showLogin('That account cannot open the drivers dashboard.');
    return;
  }
  if (!user) { showLogin(); return; }

  el('login').hidden = true;
  el('app').hidden = false;
  if (!window.DRIVERS_API.base) {
    document.getElementById('view').innerHTML =
      '<div class="card"><p class="err">This dashboard has no backend address configured.</p>'
      + '<p class="muted">Set <code>API_BASE</code> in <code>legal/drivers/config.js</code> to the Cloud Run URL and redeploy hosting '
      + '(<code>firebase deploy --only hosting</code>). Until then nothing can load — the dashboard will not invent numbers to fill the screen.</p></div>';
    document.getElementById('tabs').innerHTML = '';
    return;
  }
  window.DRIVERS_VIEWS.renderTabs();
  window.DRIVERS_VIEWS.render();
});
