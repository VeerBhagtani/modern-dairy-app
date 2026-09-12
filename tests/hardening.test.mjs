/* Regression tests for the security fixes applied in the hardening pass.
 *
 * These assert INVARIANTS rather than behaviour where the real enforcement
 * lives in a file we cannot execute here (firestore.rules needs the Firestore
 * emulator, which this environment has no network for). A structural assertion
 * over the rules text is weaker than an emulator test — it proves the rule is
 * written, not that Firestore enforces it the way we think — so where that is
 * the case it is said plainly in the test name. The emulator suite is still
 * the right thing to add; see the note at the bottom of this file.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name); } };

const rules = read('backend', 'firestore.rules');
const app = read('www', 'index.html');
const admin = read('legal', 'admin', 'index.html');

console.log('\n-- Firestore rules (structural) --');

// The bypass this closes: a forged order could set priceVerified:true and the
// out-of-band price checker would skip it entirely.
ok(/priceVerified/.test(rules) && /get\('priceVerified', false\) == false/.test(rules),
  'order create pins priceVerified to false (forged true cannot skip the price check)');
ok(/hasOnly\(\[[^\]]*'priceVerified'[^\]]*\]\)/.test(rules),
  'priceVerified is inside the hasOnly key set (so the pin is reachable)');

// The credit hold must consult something the client cannot choose.
ok(/blockedUids/.test(rules) && /request\.auth\.uid in blockList\(\)\.get\('blockedUids'/.test(rules),
  'credit hold checks request.auth.uid, not only the client-supplied phone');
ok(!/allow read: if true;\s*\/\/ opaque phone hashes/.test(rules),
  'the public phone-hash list is no longer world-readable');
ok(/match \/order_blocks_public\/\{docId\} \{\s*\n\s*allow read, write: if isAdmin\(\);/.test(rules),
  'order_blocks_public is admin-only');

// Admin identity should be revocable without a rules redeploy.
ok(/request\.auth\.token\.get\('admin', false\) == true/.test(rules),
  'isAdmin() honours a custom claim, not only a hardcoded uid');

// The catch-all must not hand every future collection to the admin by default.
ok(/match \/\{document=\*\*\} \{\s*\n\s*allow read, write: if false;/.test(rules),
  'the {document=**} catch-all denies rather than granting blanket admin access');

console.log('\n-- OTP test bypass fails closed --');

// The bug: OTP_TESTING_MODE = !OTP_HAS_CREDENTIAL, so a build that simply
// failed to receive its secrets accepted 0000 for EVERY phone number.
const otpLine = /const OTP_TESTING_MODE = ([^;]+);/.exec(app);
ok(!!otpLine, 'OTP_TESTING_MODE is declared');
ok(otpLine && /DEMO_BUILD/.test(otpLine[1]),
  'OTP test mode requires an explicit DEMO_BUILD opt-in');
ok(otpLine && !/^\s*!OTP_HAS_CREDENTIAL\s*$/.test(otpLine[1]),
  'OTP test mode is NOT derived from a missing credential alone');

// inject-secrets must refuse the one combination that would ship the bypass in
// a build that can also send real SMS.
{
  // inject-secrets writes www/secrets.js, so snapshot and restore the real
  // file around this. (Restoring with `git checkout` would be wrong: it would
  // throw away any uncommitted edit to that file rather than putting back what
  // was actually there.)
  const secretsPath = path.join(ROOT, 'www', 'secrets.js');
  const before = fs.readFileSync(secretsPath, 'utf8');
  let refused = false;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'inject-secrets.js')], {
      env: { ...process.env, DEMO_BUILD: 'true', OTP_CUSTOMER_ID: 'x', OTP_AUTH_TOKEN: 'y' },
      stdio: 'pipe',
    });
  } catch (e) { refused = true; }
  fs.writeFileSync(secretsPath, before, 'utf8');
  ok(refused, 'inject-secrets refuses DEMO_BUILD alongside real OTP credentials');
}

console.log('\n-- Payments are settled server-side only --');

const payments = read('backend', 'src', 'routes', 'payments.js');
const index = read('backend', 'src', 'index.js');
ok(/verifyWebhookSignature/.test(payments), 'the webhook route verifies the signature');
{
  // Compare real statements, not prose: the comment above the mount mentions
  // express.json() by name, so a plain indexOf over the whole file finds the
  // comment first and the ordering check silently passes for the wrong reason.
  const code = index.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const rawAt = code.indexOf('app.use(\'/payments/razorpay/webhook\', express.raw(');
  const jsonAt = code.indexOf('app.use(express.json(');
  ok(rawAt !== -1 && jsonAt !== -1 && rawAt < jsonAt,
    'raw body parser is mounted for the webhook BEFORE express.json consumes it');
}
ok(/razorpay_webhook_secret/.test(read('backend', 'src', 'services', 'razorpayClient.js')),
  'webhook verification uses the webhook secret, not the API key secret');
ok(!/fakeRazorpayPay|__rzpFakeSuccess\s*=/.test(app),
  'the simulated-payment path is gone from the client');
ok(/paymentId/.test(payments) && /status === 'settled'/.test(payments),
  'settlement is idempotent on the Razorpay payment id');

console.log('\n-- Backend entitlement comes from server state --');

const orders = read('backend', 'src', 'routes', 'orders.js');
const auth = read('backend', 'src', 'routes', 'auth.js');
ok(/customerSnap\.data\(\)\.customerType === 'b2b'/.test(orders),
  'order pricing reads the tier from the customer record, not the request');
ok(/isB2B \? \(variant\.b2b \?\? variant\.mrp\) : variant\.mrp/.test(orders),
  'retail customers are priced at MRP, not the wholesale price');
ok(/if \(isB2B && subtotal < minOrderValue\)/.test(orders),
  'the minimum order value applies to business accounts only');
ok(/gstVerifications\(\)/.test(auth) && /const tier = verifiedGst \? 'b2b' : 'b2c'/.test(auth),
  'b2b tier requires a server-held GSTIN verification, never the URL');
ok(/messageCentralClient/.test(auth) && !/require\('\.\.\/services\/smsClient'\)/.test(auth),
  'auth uses the same OTP provider as the rest of the system');

console.log('\n-- Refresh tokens are revocable --');
const authMw = read('backend', 'src', 'middleware', 'auth.js');
ok(/jti/.test(authMw) && /refreshTokens\(\)/.test(authMw), 'refresh tokens are tracked server-side by jti');
ok(/revokeFamily/.test(authMw), 'a token family can be revoked');
ok(/reuse detected/.test(authMw), 'replaying a spent refresh token is treated as theft');

console.log('\n-- CI does not run untrusted code beside a secret --');
const wf = read('.github', 'workflows', 'apply-audit-fixes.yml');
const testJob = wf.slice(wf.indexOf('  test:'), wf.indexOf('  report:'));
ok(/gh pr checkout/.test(testJob), 'the test job is the one that checks out the PR');
ok(!/FCM_SERVICE_ACCOUNT_JSON/.test(testJob),
  'the job that runs pull-request code holds no service account');
ok(/FCM_SERVICE_ACCOUNT_JSON/.test(wf.slice(wf.indexOf('  report:'))),
  'the reporting job (which runs no PR code) is the one holding the secret');

console.log('\n-- Admin panel gates fulfilment on the price check --');
ok(/FULFILMENT_STATUSES/.test(admin) && /priceMismatch === true/.test(admin),
  'confirming/shipping an order with a price mismatch requires an explicit confirmation');
ok(/priceCheckStaleWarning/.test(admin),
  'a stalled price checker is surfaced in the orders view');
ok(/blockedUids/.test(admin), 'blocking a customer records their uid, not just a phone number');
ok(!/order_blocks_public/.test(admin.replace(/order_blocks_public\/hashes is GONE[\s\S]*?keyspace[^\n]*\n/, '')),
  'the admin panel no longer writes the public phone-hash list');

console.log(`\nHARDENING: ${pass} passed, ${fail} failed`);
/* STILL MISSING, and worth saying out loud: none of the rules assertions above
   prove Firestore ENFORCES anything — they prove the text is present. The real
   test is @firebase/rules-unit-testing against the emulator, asserting
   assertFails() for: reading another customer's order, listing deliveries,
   writing a customer_accounts id under someone else's uid, setting
   priceVerified true on create, and ordering while blocked. That needs network
   access to fetch the emulator, which this environment does not have. */
if (fail) process.exit(1);
