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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DRIVER_ROUTES = read('backend/src/routes/driver.js');
const ADMIN_ROUTES = read('backend/src/routes/driversAdmin.js');
const REPO = read('backend/src/services/driversRepo.js');
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
  assert.ok(/action: kind === 'timeout' \? 'ride\.auto_close' : 'ride\.stop'/.test(REPO),
    'stopRide must write an audit entry for both admin and timeout closures');
  const job = read('backend/src/jobs/driversMaintenance.js');
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

test('the enrolment code is stored only as a bcrypt hash', () => {
  assert.ok(/bcrypt\.hash\(code, 10\)/.test(REPO), 'the code must be hashed before it is stored');

  // The plaintext `code` may appear only where it is hashed and where it is
  // returned once to the admin who created the driver. It must never reach a
  // Firestore write — so check every line that writes a document.
  const writeLines = REPO.split('\n').filter((l) => /tx\.set\(|tx\.update\(|\.set\(|\.update\(|\.add\(/.test(l));
  for (const line of writeLines) {
    assert.ok(!/\bcode\b(?!Hash)/.test(line), `a document write references the plaintext code: ${line.trim()}`);
  }
  // And the stored field is the hash.
  assert.ok(/enrolment: \{ codeHash/.test(REPO));
  assert.ok(/'enrolment\.codeHash': codeHash/.test(REPO));
});

test('the driver list never leaks the enrolment hash', () => {
  assert.ok(/\.map\(\(\{ enrolment, \.\.\.safe \}\)/.test(REPO), 'listDrivers must strip the enrolment object');
  assert.ok(/function pickSafe/.test(REPO));
});

test('enrolment failures do not reveal whether a code exists', () => {
  const i = DRIVER_ROUTES.indexOf("router.post('/enrol'");
  const route = DRIVER_ROUTES.slice(i, i + 2200);
  const messages = [...route.matchAll(/message: '([^']+)'/g)].map((m) => m[1]);
  const failures = messages.filter((m) => /not valid|expired|already/i.test(m));
  assert.equal(new Set(failures).size, 1, `enrolment failure messages differ: ${JSON.stringify(failures)}`);
});

// ── rate limiting ────────────────────────────────────────────────────────

test('the GPS and enrolment endpoints are rate limited', () => {
  assert.ok(/gpsIngestLimiter/.test(DRIVER_ROUTES));
  assert.ok(/enrolLimiter/.test(DRIVER_ROUTES));
  const rl = read('backend/src/middleware/rateLimit.js');
  assert.ok(/keyGenerator: \(req\) => req\.driverId \|\| req\.ip/.test(rl),
    'the GPS limiter must be keyed per driver, so one bad network cannot exhaust the fleet budget');
});

// ── Firestore rules ──────────────────────────────────────────────────────

test('every rules match block sits at brace depth 2', () => {
  // This exact bug has shipped in this file before: a match block that drifts
  // inside another one silently stops applying.
  let depth = 0;
  const lines = RULES.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const before = depth;
    for (const ch of line) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
    }
    const m = line.match(/^\s*match\s+\/(\w+)/);
    if (!m) continue;
    // Top-level collections at 2; sub-collections at 3; the databases match at 1.
    assert.ok(before === 1 || before === 2 || before === 3,
      `line ${i + 1}: match block at depth ${before}: ${line.trim()}`);
  }
  assert.equal(depth, 0, 'unbalanced braces in firestore.rules');
});

test('no client, of any identity, may write raw GPS', () => {
  const i = RULES.indexOf('match /gps_raw/{pointId}');
  assert.ok(i > 0, 'gps_raw has no explicit rule');
  const block = RULES.slice(i, i + 200);
  assert.ok(/allow read, write: if false;/.test(block),
    'raw GPS must be unwritable from every client — it is immutable evidence');
});

test('the drivers collections deny client writes', () => {
  for (const col of ['drivers', 'ride_processing', 'segment_reviews', 'delivery_orders', 'drivers_audit_log', 'drivers_config']) {
    const i = RULES.indexOf(`match /${col}/`);
    assert.ok(i > 0, `${col} has no explicit rule`);
    assert.ok(/write: if false/.test(RULES.slice(i, i + 260)), `${col} allows a client write`);
  }
});

test('the live map collections are readable by the admin and nobody else', () => {
  const i = RULES.indexOf('match /driver_live/{driverId}');
  const block = RULES.slice(i, i + 160);
  assert.ok(/allow read: if isAdmin\(\);/.test(block));
  assert.ok(/allow write: if false;/.test(block));
});

// ── no secrets ───────────────────────────────────────────────────────────

test('no credential is hardcoded in the new subsystem', () => {
  const files = [
    'backend/src/routes/driver.js', 'backend/src/routes/driversAdmin.js',
    'backend/src/services/driversRepo.js', 'backend/src/services/orderSource/gofrugal.js',
    'backend/src/middleware/driverAuth.js',
    'driver-app/www/app.js', 'driver-app/www/config.js',
    'legal/drivers/api.js', 'legal/drivers/app.js',
  ];
  // The Firebase web API key in legal/drivers/config.js is deliberately public
  // (it identifies the project; access is gated by rules and by the backend's
  // uid check), exactly as the existing admin panel treats it, so config.js is
  // checked separately below.
  for (const f of files) {
    const src = read(f);
    assert.ok(!/AIza[0-9A-Za-z_-]{30,}/.test(src), `${f} contains what looks like a Google API key`);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(src), `${f} contains a private key`);
    assert.ok(!/\b(password|secret|token)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/i.test(src),
      `${f} appears to contain a hardcoded credential`);
  }
});

test('the driver app ships with no server address and refuses to invent one', () => {
  const cfg = read('driver-app/www/config.js');
  assert.match(cfg, /API_BASE:\s*''/, 'the committed config must not carry an environment URL');
  const app = read('driver-app/www/app.js');
  assert.ok(/no server address/.test(app), 'the app must say so rather than pretending to track');
  assert.ok(!/DEMO|fakeGps|seedPoints|Math\.random\(\)\s*\*\s*0\.0/.test(app),
    'the driver app must never synthesise GPS data');
});

test('secrets reach the backend through Secret Manager, not the environment', () => {
  const gf = read('backend/src/services/orderSource/gofrugal.js');
  assert.ok(/getSecret\('gofrugal'\)/.test(gf));
  assert.ok(!/process\.env\.GOFRUGAL_API_KEY/.test(gf));
});
