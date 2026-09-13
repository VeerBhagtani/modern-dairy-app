// Deployment gate — tests the checks, not the thing being checked.
//
// scripts/preflight.js and the two injectors are the only things standing
// between a bad tree and a published build. A gate that silently passes
// everything is worse than no gate, because it is believed. So every refusal
// below is provoked for real: the file is corrupted the way a person would
// corrupt it, the script is run as a subprocess, and the exit code is
// checked. Every file touched is snapshotted and restored in the `finally`.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + m); };

const SNAPSHOT = ['www/config.js', 'www/secrets.js'];
const saved = new Map(SNAPSHOT.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
const restore = () => { for (const [f, v] of saved) fs.writeFileSync(path.join(ROOT, f), v, 'utf8'); };
const write = (f, v) => fs.writeFileSync(path.join(ROOT, f), v, 'utf8');

// Runs a script and reports only whether it accepted or refused, plus its
// output — never throwing, so one unexpected pass doesn't hide the rest.
function run(script, args = [], env = {}) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args],
      { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { accepted: true, out };
  } catch (e) {
    return { accepted: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

try {
  // ── repo mode: the committed tree is deployable ──
  console.log('\n── preflight, repo mode ──');
  let r = run('preflight.js');
  ok(r.accepted, 'the committed tree passes preflight');
  ok(/0 failed/.test(r.out), 'preflight reports zero failures on a clean tree');

  // The warning about the hardcoded admin uid must NOT be silently dropped —
  // it is the reminder for DEPLOYMENT.md step 6, and it is the kind of thing
  // that quietly disappears when someone tidies the rules file.
  ok(/hardcoded admin uid|0 warnings/.test(r.out),
    'preflight surfaces the admin-uid fallback while it is still in the rules');

  // ── repo mode refuses a build-time tree committed by mistake ──
  console.log('\n── preflight refuses a tree that was built in place ──');
  write('www/config.js', 'window.APP_CONFIG = {"API_BASE":"https://x.a.run.app/api","DEMO":false,"RAZORPAY_KEY":""};');
  r = run('preflight.js');
  ok(!r.accepted && /committed www\/config\.js is the DEMO placeholder/.test(r.out),
    'a config.js pointed at a real backend is refused');
  restore();

  write('www/secrets.js', 'window.APP_SECRETS = {"OTP_CUSTOMER_ID":"C-123456","OTP_AUTH_TOKEN":"","GST_API_KEY":"","GST_API_SECRET":"","DEMO_BUILD":""};');
  r = run('preflight.js');
  ok(!r.accepted && /carries no credentials/.test(r.out), 'a secrets.js with a credential in it is refused');
  ok(/ROTATE/.test(r.out), 'and says to rotate it, because reverting the file does not un-leak it');
  restore();

  // A URL in a value used to break the lenient parser (it strips // line
  // comments, which also cut https:// in half) and the file read as corrupt.
  console.log('\n── the parser survives values containing "//" ──');
  write('www/config.js', 'window.APP_CONFIG = {"API_BASE":"","DEMO":true,"RAZORPAY_KEY":""};');
  r = run('preflight.js');
  ok(r.accepted, 'a strict-JSON config.js (as generated) parses');
  restore();

  // ── inject-config: the refusals ──
  console.log('\n── inject-config refusals ──');
  const cases = [
    [{ DEMO: 'false' }, /no API_BASE/, 'DEMO=false with no backend URL'],
    [{ API_BASE: 'http://api.example.com/api' }, /must be https/, 'a cleartext API_BASE the WebView would block'],
    [{ API_BASE: 'not-a-url' }, /not a valid absolute URL/, 'a malformed API_BASE'],
    [{ API_BASE: 'https://x.a.run.app/api', RAZORPAY_KEY: 'aB3xQ9zzNotAKeyId' },
      /never be put in www\/config\.js/, 'a Razorpay key SECRET in the publishable-key slot'],
  ];
  for (const [env, re, what] of cases) {
    const res = run('inject-config.js', [], env);
    ok(!res.accepted && re.test(res.out), 'refuses ' + what);
    restore();
  }

  // ── inject-config: the accepted shapes ──
  console.log('\n── inject-config accepted shapes ──');
  let res = run('inject-config.js', [], {});
  const demoCfg = fs.readFileSync(path.join(ROOT, 'www/config.js'), 'utf8');
  ok(res.accepted && /"DEMO": true/.test(demoCfg) && /"API_BASE": ""/.test(demoCfg),
    'no environment at all yields a DEMO build (a misconfigured CI run cannot ship half-live)');

  // Assembled rather than written out: scripts/check-no-secrets.js matches the
  // SHAPE of a Razorpay key, and it is right to — a test fixture is not a good
  // enough reason to teach the credential tripwire to ignore something.
  const FAKE_RZP = ['rzp', 'live', 'AbC123456789'].join('_');
  res = run('inject-config.js', [], { API_BASE: 'https://svc.a.run.app/api/', RAZORPAY_KEY: FAKE_RZP });
  const liveCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'www/config.js'), 'utf8')
    .match(/window\.APP_CONFIG = (\{[\s\S]*?\});/)[1]);
  ok(res.accepted && liveCfg.DEMO === false, 'an API_BASE alone flips DEMO off — no second variable to forget');
  ok(liveCfg.API_BASE === 'https://svc.a.run.app/api', 'the trailing slash is stripped (it would double up in every URL)');
  ok(!res.out.includes('AbC123456789'), 'the full Razorpay key is not echoed into the CI log');
  restore();

  // ── inject-secrets: the combination that must never ship ──
  console.log('\n── inject-secrets refusals ──');
  res = run('inject-secrets.js', [], { DEMO_BUILD: 'true', OTP_AUTH_TOKEN: 'live-token-value' });
  ok(!res.accepted && /REFUSING TO BUILD/.test(res.out),
    'refuses the OTP test bypass alongside a credential that can send real SMS');
  ok(!res.out.includes('live-token-value'), 'and does not print the credential while refusing');
  restore();

  res = run('inject-secrets.js', [], {});
  ok(res.accepted && !/"DEMO_BUILD": "true"/.test(fs.readFileSync(path.join(ROOT, 'www/secrets.js'), 'utf8')),
    'a build with no secrets does NOT turn the bypass on (a missing input must narrow, never widen)');
  restore();

  // ── built mode ──
  console.log('\n── preflight --built ──');
  run('inject-secrets.js', [], {});
  run('inject-config.js', [], {});
  r = run('preflight.js', ['--built']);
  ok(r.accepted && /0 failed/.test(r.out), 'a clean DEMO build passes built-mode preflight');
  ok(/DEMO mode/.test(r.out), 'and says out loud that it talks to no backend');

  run('inject-secrets.js', [], { OTP_CUSTOMER_ID: 'c', OTP_AUTH_TOKEN: 't', GST_API_KEY: 'k', GST_API_SECRET: 's' });
  run('inject-config.js', [], { API_BASE: 'https://svc.a.run.app/api' });
  r = run('preflight.js', ['--built']);
  ok(r.accepted && /DEMO=false, DEMO_BUILD=false, credentials=4\/4/.test(r.out),
    'a fully-configured live build passes built-mode preflight');

  // Built mode's whole reason for existing: catching the two files disagreeing
  // after injection, which no single injector can see.
  write('www/secrets.js', 'window.APP_SECRETS = {"OTP_CUSTOMER_ID":"c","OTP_AUTH_TOKEN":"t","GST_API_KEY":"k","GST_API_SECRET":"s","DEMO_BUILD":"true"};');
  r = run('preflight.js', ['--built']);
  ok(!r.accepted && /not combined with real credentials/.test(r.out),
    'built mode catches the bypass smuggled in beside live credentials');

  write('www/secrets.js', 'window.APP_SECRETS = {"OTP_CUSTOMER_ID":"","OTP_AUTH_TOKEN":"","GST_API_KEY":"","GST_API_SECRET":"","DEMO_BUILD":""};');
  write('www/config.js', 'window.APP_CONFIG = {"API_BASE":"","DEMO":false,"RAZORPAY_KEY":""};');
  r = run('preflight.js', ['--built']);
  ok(!r.accepted && /a live build has an API_BASE to call/.test(r.out),
    'built mode catches a live build with no server to call');
  restore();
} finally {
  restore();
}

// ── the release build must be able to happen twice ──
console.log('\n── release plumbing ──');
const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
ok(/versionCode\s+System\.getenv\("ANDROID_VERSION_CODE"\)/.test(gradle),
  'versionCode comes from the environment (Play rejects a code it has already seen)');

const aab = fs.readFileSync(path.join(ROOT, '.github/workflows/build-release-aab.yml'), 'utf8');
ok(/npm run preflight\b/.test(aab) && /npm run test:all/.test(aab),
  'the release workflow gates on preflight and the full suite');
ok(/preflight:built/.test(aab), 'and preflights the generated build config before packaging');
ok(/ANDROID_VERSION_CODE: \$\{\{ github\.run_number \}\}/.test(aab), 'and gives each release a fresh versionCode');
ok(/jarsigner -verify/.test(aab), 'and verifies the AAB is signed rather than trusting the build');

const fb = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-firebase.yml'), 'utf8');
ok(/npm run test:rules/.test(fb),
  'the rules deploy runs the emulator suite first (these rules ARE the security boundary)');

const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
ok(/setup-java/.test(ci) && /npm run test:all/.test(ci),
  'CI installs a JVM and runs the full suite, so test:rules cannot silently skip');

// ── the bundle we ship has to start without a network ──
// Measured with every remote host unreachable, first paint was 13 seconds of
// blank screen: boot() awaited two un-deadlined Firestore fetches, and a
// render-blocking remote stylesheet held up config.js behind it. Both had
// working fallbacks that nothing was reaching in time. These assertions exist
// because that is exactly the kind of thing that gets reintroduced by someone
// adding "just one more fetch" to the boot path.
console.log('\n── cold start ──');
const appHtml = fs.readFileSync(path.join(ROOT, 'www/index.html'), 'utf8');

// Scoped to READS, deliberately. Every Firestore REST read here is on the
// boot path, where an unbounded request is a blank screen. The one REST
// WRITE (mirrorOrderViaRest) is intentionally left unbounded: it is the
// last-resort path for the only durable record of an order, and aborting a
// POST that may already have committed would orphan the order rather than
// save the customer any time. So this asserts what it can actually justify.
const bootReads = [...appHtml.matchAll(/\bfetch\(\s*'(https:\/\/firestore\.googleapis\.com[^']*)'/g)];
const undeadlinedReads = bootReads.filter((m) => !/documents\/orders'?$/.test(m[1]));
ok(undeadlinedReads.length === 0,
  'every Firestore REST read on the boot path has a deadline (a dead network must not hold the first paint)',
  undeadlinedReads.map((m) => m[1].slice(0, 80)).join('\n'));
ok(/mirrorOrderViaRest[\s\S]{0,300}?await fetch\(\s*'https:\/\/firestore\.googleapis\.com/.test(appHtml),
  'the order-mirror write is still the plain unbounded fetch it needs to be');
ok(/function fetchWithDeadline\([^)]*\)\s*\{[\s\S]{0,400}?AbortController/.test(appHtml),
  'fetchWithDeadline aborts the request rather than just racing it');

const fontLink = appHtml.match(/<link[^>]+fonts\.googleapis\.com[^>]*rel="stylesheet"[^>]*>/);
ok(fontLink && /media="print"/.test(fontLink[0]) && /onload="this\.media='all'"/.test(fontLink[0]),
  'the remote font stylesheet loads non-blocking (a pending one blocks every classic script after it)');
ok(/<script src="https:\/\/checkout\.razorpay\.com[^"]*"\s+(defer|async)><\/script>/.test(appHtml),
  'the Razorpay checkout script does not block startup (it is only needed at payment time)');
ok(/if\(!window\.Razorpay\b/.test(appHtml),
  'and the payment path still checks it actually loaded before using it');

// Restoration is the point of the finally above — if it failed, every later
// run of this test lies, so check it here rather than trusting it.
for (const [f, v] of saved) {
  ok(fs.readFileSync(path.join(ROOT, f), 'utf8') === v, f + ' was restored exactly');
}

console.log('\nDEPLOY PREFLIGHT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
