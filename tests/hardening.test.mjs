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
ok(/request\.resource\.data\.priceVerified == false/.test(rules),
  'order create pins priceVerified to false (a forged true cannot skip the price check)');
ok(/hasOnly\(\[[^\]]*'priceVerified'[^\]]*\]\)/.test(rules),
  'priceVerified is inside the hasOnly key set (so the pin is reachable)');
// The bug this catches, found in the second pass: the field was PERMITTED but
// not REQUIRED, and the rule read it with .get(...,false). Omitting it
// therefore passed the rule AND left the document unmatched by the
// `where priceVerified == false` query the price checker runs — so the order
// was never price-checked at all. Pinning alone is not enough; it has to exist.
ok(/hasAll\(\[[^\]]*'priceVerified'[^\]]*\]\)/.test(rules),
  'priceVerified is REQUIRED, so an order cannot hide from the price check by omitting it');
ok(!/get\('priceVerified'/.test(rules),
  'the rule does not default a missing priceVerified to false');

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

/* ── The order payload must satisfy the rules' hasAll ──────────────────────
   This is the check that the rest of the suite cannot make. buildOrderDoc
   lives inside the `type="module"` Firestore-mirror block, which imports the
   Firebase SDK from gstatic — so it never executes in a browser test run
   offline, and stubbing window.mirrorOrderToFirestore (as the Playwright
   drivers do) captures the payload BEFORE buildOrderDoc has touched it.
   That matters a lot right now: the order-create rule REQUIRES priceVerified,
   so if buildOrderDoc ever stops emitting it, Firestore rejects every single
   order and the failure only shows up in production. Extract the real function
   and run it. */
console.log('\n-- Order payload satisfies the Firestore rules --');
{
  const m = /function buildOrderDoc\(order, uid\) \{[\s\S]*?\n\}/.exec(app);
  ok(!!m, 'buildOrderDoc source found in www/index.html');
  if (m) {
    // eslint-disable-next-line no-new-func
    const buildOrderDoc = new Function(`${m[0]}; return buildOrderDoc;`)();
    const doc = buildOrderDoc({
      orderNo: 'MD123', items: [{ pk: 'p', vid: 'v', qty: 2, price: 50 }],
      subtotal: 100, gst: 5, delivery: 0, platform: 2, total: 107,
      payment: 'cod', customerType: 'b2c', name: 'A', phone: '9811111111',
      address: 'somewhere',
    }, 'uid-123');

    // Exactly the hasAll list in backend/firestore.rules.
    const REQUIRED = ['orderNo', 'items', 'subtotal', 'gst', 'delivery', 'total',
      'status', 'placedAt', 'createdByUid', 'priceVerified'];
    // placedAt is added by the caller (serverTimestamp on the SDK path, an ISO
    // string on the REST path), so it is legitimately absent from this object.
    const missing = REQUIRED.filter(k => k !== 'placedAt' && !(k in doc));
    ok(missing.length === 0, `order payload carries every rule-required field (missing: ${missing.join(', ') || 'none'})`);
    ok(doc.priceVerified === false, 'buildOrderDoc emits priceVerified === false, which the rule pins');
    ok(doc.status === 'placed', 'buildOrderDoc pins status to placed');
    ok(doc.createdByUid === 'uid-123', 'buildOrderDoc stamps the caller uid as owner');

    // hasOnly: any extra key is a rejected write.
    const PERMITTED = new Set(['orderNo', 'items', 'subtotal', 'gst', 'delivery', 'platform',
      'total', 'payment', 'customerType', 'company', 'gstin', 'name', 'phone', 'address',
      'status', 'createdByUid', 'placedAt', 'priceVerified']);
    const extra = Object.keys(doc).filter(k => !PERMITTED.has(k));
    ok(extra.length === 0, `order payload adds no key outside the rule's hasOnly (extra: ${extra.join(', ') || 'none'})`);
  }
}

/* Same class of silent failure, different document. syncCustomerAccount writes
   customer_accounts, whose rule also uses hasOnly — and syncAccount()'s only
   error handling is a console.warn, so a field the rule does not permit means
   every customer profile silently stops reaching the office, with nothing
   visible anywhere. Compare the two lists directly. */
console.log('\n-- Account sync payload matches its rule --');
{
  const syncFields = /const ACCOUNT_SYNC_FIELDS = (\[[^\]]*\])/.exec(app);
  ok(!!syncFields, 'ACCOUNT_SYNC_FIELDS found');
  const ruleList = /hasOnly\((\['phone', 'type'[^\]]*\])\)/.exec(rules);
  ok(!!ruleList, 'customer_accounts hasOnly list found in the rules');
  if (syncFields && ruleList) {
    // eslint-disable-next-line no-new-func
    const sent = new Set(new Function(`return ${syncFields[1]}`)());
    // These three are written explicitly by syncCustomerAccount, plus the two
    // timestamps it stamps on create/update.
    ['phone', 'type', 'bankVerified', 'createdAt', 'updatedAt'].forEach(k => sent.add(k));
    // eslint-disable-next-line no-new-func
    const permitted = new Set(new Function(`return ${ruleList[1]}`)());
    const rejected = [...sent].filter(k => !permitted.has(k));
    ok(rejected.length === 0,
      `every field the app syncs is permitted by the rule (would be rejected: ${rejected.join(', ') || 'none'})`);
    ok(sent.has('outlet') && permitted.has('outlet'),
      'the Outlet Details map is both sent and permitted (floor/lift/landmark reach the office and the rider)');
  }
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
