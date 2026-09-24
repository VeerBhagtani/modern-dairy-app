// Security and authorisation invariants.
//
// Some of these are static checks on the route source rather than live HTTP
// calls. That is deliberate: the rules they protect are ARCHITECTURAL — "no
// code path lets a driver stop a ride", "a driver id is never read from a
// request body" — and an architectural rule is best enforced by failing the
// build when the shape of the code changes, not by hoping a request-level test
// happens to cover the new path somebody adds.
//
// The live request-level behaviour of these routes is covered by the manual
// test plan in docs/modern-drivers/TESTING.md, which runs against a deployed
// instance with a real Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DRIVER_ROUTES = read('backend/src/routes/driver.js');
const ADMIN_ROUTES = read('backend/src/routes/admin.js');
const REPO = read('backend/src/services/repo.js');
const RULES = read('backend/firestore.rules');

// ── ride control ─────────────────────────────────────────────────────────

test('the driver API contains no code path that stops a ride', () => {
  // repo.stopRide is the ONLY way a ride stops. It must not appear in the
  // driver-facing router at all.
  assert.ok(!/\bstopRide\s*\(/.test(DRIVER_ROUTES),
    'routes/driver.js calls stopRide — a driver must never be able to stop a ride');
  // Nor may it write the ride status directly.
  assert.ok(!/status:\s*['"]stopped['"]/.test(DRIVER_ROUTES));
});

test("the driver's stop endpoint refuses, records, and returns 403", () => {
  const stopRoute = DRIVER_ROUTES.slice(DRIVER_ROUTES.indexOf("router.post('/rides/:rideId/stop'"));
  assert.ok(/res\.status\(403\)/.test(stopRoute), 'the driver stop endpoint must always return 403');
  assert.ok(/unauthorized_ride_control/.test(stopRoute), 'the attempt must be recorded');
  assert.ok(/raiseAlertOnce/.test(stopRoute), 'the attempt must raise an alert');
});

test('the admin stop endpoint is role-gated and demands a reason', () => {
  const i = ADMIN_ROUTES.indexOf("router.post('/rides/:rideId/stop'");
  assert.ok(i > 0, 'the admin stop endpoint is missing');
  const route = ADMIN_ROUTES.slice(i, i + 1400);
  assert.ok(/requireRole\('manager'\)/.test(route), 'stopping a ride must need at least the manager role');
  assert.ok(/isBoundedString\(reason/.test(route), 'a reason must be required');
  assert.ok(/by: `admin:\$\{req\.adminId\}`/.test(route), 'the stopping admin must be recorded');
});

test('every ride stop is audited, including the automatic one', () => {
  assert.ok(/action: kind === 'timeout' \? 'ride\.auto_close' : kind === 'day_end' \? 'ride\.day_end' : 'ride\.stop'/.test(REPO),
    'stopRide must write an audit entry for admin, timeout and day-end closures');
  // Rides closed at the end of their day inside startRide's transaction are
  // audited too, after it commits.
  assert.ok(/action: 'ride\.day_end', target: c\.rideId/.test(REPO), 'startRide audits the rides it closes');
  const job = read('backend/src/jobs/maintenance.js');
  assert.ok(/kind: 'timeout'/.test(job));
  assert.ok(/the configured limit is \$\{cfg\.autoStopAfterHours\}/.test(job),
    'an auto-close must record the threshold that closed it');
});

// ── driver scoping ───────────────────────────────────────────────────────

test('the driver API never takes a driver id from the request', () => {
  // req.driverId is set by the auth middleware from the token. Any read of a
  // driverId out of the body, query or params would be a horizontal-privilege
  // escalation waiting to happen.
  assert.ok(!/req\.body[^\n]*driverId/.test(DRIVER_ROUTES));
  assert.ok(!/req\.params[^\n]*driverId/.test(DRIVER_ROUTES));
  assert.ok(!/req\.query[^\n]*driverId/.test(DRIVER_ROUTES));
  assert.ok(/req\.driverId/.test(DRIVER_ROUTES), 'it should use the token-derived id');
});

test('uploading points into another driver\'s ride is refused and recorded', () => {
  const i = DRIVER_ROUTES.indexOf("router.post('/rides/:rideId/points'");
  const route = DRIVER_ROUTES.slice(i, i + 2500);
  assert.ok(/ride\.driverId !== req\.driverId/.test(route), 'ride ownership must be checked');
  assert.ok(/cross_driver_upload_blocked/.test(route));
  assert.ok(/res\.status\(403\)/.test(route));
});

test('the driver token is re-checked against the live account on every request', () => {
  const auth = read('backend/src/middleware/driverAuth.js');
  assert.ok(/repo\.getDriver\(payload\.sub\)/.test(auth), 'the driver document must be re-read, not trusted from the token');
  assert.ok(/driver\.status !== 'active'/.test(auth), 'a deactivated driver must stop working immediately');
  assert.ok(/driver\.deviceId && payload\.did && driver\.deviceId !== payload\.did/.test(auth), 'the device binding must be enforced');
  assert.ok(/algorithms: \['HS256'\]/.test(auth), 'the JWT algorithm must be pinned');
});

test('a driver can only declare a trip PERSONAL, never BUSINESS', () => {
  const i = DRIVER_ROUTES.indexOf("router.post('/rides/:rideId/declare'");
  const route = DRIVER_ROUTES.slice(i, i + 1600);
  assert.ok(/kind !== 'personal'/.test(route), 'only a personal declaration may be accepted');
  // The classification engine backs this up: no rule turns a declaration into
  // business distance.
  const cls = read('backend/src/drivers/classification.js');
  assert.ok(!/declaration.*kind === 'business'/.test(cls));
});

// ── mass assignment and input validation ─────────────────────────────────

test('admin driver updates cannot set status, role, enrolment or device', () => {
  const i = ADMIN_ROUTES.indexOf("router.patch('/:driverId'");
  const route = ADMIN_ROUTES.slice(i, i + 900);
  const picked = route.match(/pickAllowed\(req\.body, \[([^\]]+)\]/);
  assert.ok(picked, 'the patch route must use pickAllowed');
  for (const forbidden of ['status', 'role', 'enrolment', 'deviceId', 'activeRideId']) {
    assert.ok(!picked[1].includes(`'${forbidden}'`), `${forbidden} must not be settable from a request body`);
  }
});

test('ids that reach a Firestore path are validated first', () => {
  // A Firestore path is a string; an unvalidated id is a path-traversal bug.
  const routeIdUses = ADMIN_ROUTES.match(/const \{ (rideId|driverId|id|segmentId|reviewId)[^}]*\} = req\.params;/g) || [];
  assert.ok(routeIdUses.length > 5, 'expected several id-taking routes');
  assert.ok((ADMIN_ROUTES.match(/isValidId\(/g) || []).length >= routeIdUses.length,
    'every route taking an id from the path must validate it');
});

test('registration stores no secret of any kind', () => {
  // There is no password and no code, so there is nothing to leak. What has to
  // hold instead is that the account is the phone number and nothing secret is
  // written alongside it.
  assert.ok(!/bcrypt/.test(REPO), 'the driver store should have no password hashing left in it');
  assert.ok(!/enrolment|codeHash/i.test(REPO.replace(/^.*no enrolment code.*$/m, '')),
    'no enrolment machinery should remain');
  assert.ok(/C\.drivers\(\)\.doc\(deviceId\)/.test(REPO),
    'the phone is the account: the device id must be the document id, so one handset is always one driver');
});

test('the driver list carries nothing that is not safe to show the office', () => {
  const i = REPO.indexOf('async function listDrivers');
  const fn = REPO.slice(i, i + 600);
  assert.ok(!/passwordHash|codeHash|token/i.test(fn));
});

test('a deactivated driver cannot register their way back in', () => {
  const i = REPO.indexOf('async function registerDriver');
  const fn = REPO.slice(i, i + 1600);
  assert.ok(/d\.status !== 'active'/.test(fn), 'an inactive account must be refused');
  assert.ok(/INACTIVE/.test(fn));
});

test('a phone changing hands is recorded, not silently overwritten', () => {
  // With no code and no password, the compensating control is that the office
  // SEES who is driving. A handset passed to a different driver keeps working —
  // that is the point — but the previous name is kept and the change is logged.
  const i = REPO.indexOf('async function registerDriver');
  const fn = REPO.slice(i, i + 2400);
  assert.ok(/name_changed/.test(fn), 'a name change must raise an event');
  assert.ok(/previousNames/.test(fn), 'and the previous name must be kept');
});

test('registration validates its input server-side', () => {
  const i = DRIVER_ROUTES.indexOf("router.post('/register'");
  const route = DRIVER_ROUTES.slice(i, i + 1400);
  assert.ok(/isBoundedString\(name/.test(route), 'the name must be bounded');
  assert.ok(/isValidId\(deviceId\)/.test(route), 'the device id reaches a Firestore path, so it must be validated');
  assert.ok(/hasForbiddenKeys/.test(route), 'and prototype-polluting keys must be rejected');
});

test('an account the office switched off cannot register its way back in', () => {
  const i = REPO.indexOf('async function registerDriver');
  const fn = REPO.slice(i, i + 1200);
  assert.ok(/d\.status !== 'active'/.test(fn));
  assert.ok(/INACTIVE/.test(fn));
});

// ── rate limiting ────────────────────────────────────────────────────────

test('the GPS and registration endpoints are rate limited', () => {
  assert.ok(/gpsIngestLimiter/.test(DRIVER_ROUTES));
  assert.ok(/registerLimiter/.test(DRIVER_ROUTES));
  const rl = read('backend/src/middleware/rateLimit.js');
  assert.ok(/keyGenerator: \(req\) => req\.driverId \|\| req\.ip/.test(rl),
    'the GPS limiter must be keyed per driver, so one bad network cannot exhaust the fleet budget');
});

// ── Firestore rules ──────────────────────────────────────────────────────

test('the Firestore rules deny every client, for everything', () => {
  // This product has no client-side database access at all: the app holds a
  // backend token and the dashboard signs in to the backend. So the rules are a
  // flat deny, which is both the correct model and trivially auditable — unlike
  // the previous shared-project rules, where a catch-all admin grant quietly
  // re-opened collections that looked closed.
  assert.ok(/allow read, write: if false;/.test(RULES), 'there must be a deny-all');
  assert.ok(/match \/\{document=\*\*\}/.test(RULES), 'and it must cover every path');

  // Nothing may grant access back.
  const grants = RULES.split('\n').filter((l) => /allow /.test(l) && !/if false/.test(l));
  assert.deepEqual(grants, [], `no rule may grant client access: ${grants.join(' | ')}`);
});

test('the rules file is syntactically balanced', () => {
  let depth = 0;
  for (const ch of RULES) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    assert.ok(depth >= 0, 'unbalanced braces in firestore.rules');
  }
  assert.equal(depth, 0, 'unbalanced braces in firestore.rules');
});

// ── no secrets ───────────────────────────────────────────────────────────

test('no credential is hardcoded in the new subsystem', () => {
  const files = [
    'backend/src/routes/driver.js', 'backend/src/routes/admin.js',
    'backend/src/services/repo.js', 'backend/src/services/orderSource/gofrugal.js',
    'backend/src/middleware/driverAuth.js',
    'app/www/app.js', 'app/www/config.js',
    'dashboard/api.js', 'dashboard/app.js',
  ];
  // This product has no public client keys at all — no Firebase config, no map
  // key — so unlike the old shared setup there is no exception to carve out.
  for (const f of files) {
    const src = read(f);
    assert.ok(!/AIza[0-9A-Za-z_-]{30,}/.test(src), `${f} contains what looks like a Google API key`);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(src), `${f} contains a private key`);
    assert.ok(!/\b(password|secret|token)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/i.test(src),
      `${f} appears to contain a hardcoded credential`);
  }
});

test('the driver app ships with no server address and never invents a position', () => {
  const cfg = read('app/www/config.js');
  assert.match(cfg, /API_BASE:\s*''/, 'the committed config must not carry an environment URL');

  const app = read('app/www/app.js');
  // With no server the app records locally rather than refusing — but it must
  // say so, and it must never manufacture a coordinate to fill the screen.
  assert.ok(/Not connected to the office/.test(app), 'it must tell the driver nothing has been sent');
  assert.ok(!/DEMO|fakeGps|seedPoints|simulateRoute/.test(app),
    'the driver app must never synthesise GPS data');
  // Every stored point comes from the OS callback and nowhere else.
  assert.ok(/onLocation\(location, error\)/.test(app));
  assert.ok(/lat: location\.latitude/.test(app) && /lng: location\.longitude/.test(app));
});

test('the map provider is free and keyless, and named in exactly one place', () => {
  const cfg = read('app/www/config.js');
  assert.ok(/tiles\.openfreemap\.org/.test(cfg), 'OpenFreeMap needs no API key and no billing account');
  assert.ok(!/api[_-]?key|access[_-]?token|mapbox|googleapis\.com\/maps/i.test(cfg),
    'no paid or keyed map provider should appear in the app config');
});

test('secrets reach the backend through Secret Manager, not the environment', () => {
  const gf = read('backend/src/services/orderSource/gofrugal.js');
  assert.ok(/getSecret\('gofrugal'\)/.test(gf));
  assert.ok(!/process\.env\.GOFRUGAL_API_KEY/.test(gf));
});
