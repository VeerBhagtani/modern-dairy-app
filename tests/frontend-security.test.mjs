// Executable pen-test of the security-relevant frontend logic. Extracts the
// real function sources from www/index.html and exercises them against
// attacker inputs — not reimplementations.
import fs from 'fs';
import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
  clear: () => { for (const k in store) delete store[k]; },
};
globalThis.window = { APP_SECRETS: {} };

import { fileURLToPath } from 'url';
import path from 'path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(process.argv[2] || path.join(ROOT, 'www', 'index.html'), 'utf8');

function grab(names) {
  let out = '';
  for (const name of names) {
    const re = new RegExp('(?:^|\\n)(async function|function|const|let)\\s+' + name + '\\b');
    const m = re.exec(html);
    if (!m) throw new Error('not found: ' + name);
    const start = m.index + (html[m.index] === '\n' ? 1 : 0);
    if (m[1] === 'const' || m[1] === 'let') {
      let depth = 0, end = -1;
      for (let k = m.index; k < html.length; k++) {
        const c = html[k];
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        else if (c === ';' && depth === 0) { end = k; break; }
      }
      out += html.slice(start, end + 1) + '\n';
    } else {
      const j = html.indexOf('{', m.index);
      let depth = 0, end = -1;
      for (let k = j; k < html.length; k++) {
        const c = html[k];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
      }
      out += html.slice(start, end + 1) + '\n';
    }
  }
  return out;
}

const src = grab([
  'esc', 'SAFE_URL_SCHEMES', 'safeUrl', 'jsStr', 'PBKDF2_ITERATIONS', 'PW_MIN_LENGTH', 'subtle',
  'toHex', 'randomHex', 'pbkdf2Hex', 'timingSafeEqual', 'hashPassword', 'verifyPassword',
  'THROTTLE_KEY', 'THROTTLE_RULES', 'throttleAll', 'throttleSave', 'throttleMinsLeft',
  'throttleCheck', 'throttleFail', 'throttleReset',
  'GSTIN_CHARS', 'GSTIN_RE', 'isWellFormedGSTIN', 'PW_RULE_TEXT', 'isStrongEnough',
  'APPCFG_FIELDS', 'PRODUCT_FIELDS', 'MAX_REMOTE_STR', 'coerce', 'pickFields',
  'TEST_GSTIN', 'TEST_BANK', 'verifyBankAccount', 'riderCode', 'distKm',
  'SHOP_HOURS', 'clockLabel', 'shopStatus',
]) +'\nconst GST_READY = false; const LOGIN = { gstin: "" };'   // a demo build, as shipped
   + '\nfunction setLoginGstin(g){ LOGIN.gstin = g; }';

const exportLine = '\nexport {esc,safeUrl,jsStr,hashPassword,verifyPassword,timingSafeEqual,'
  + 'throttleCheck,throttleFail,throttleReset,isWellFormedGSTIN,isStrongEnough,coerce,pickFields,'
  + 'APPCFG_FIELDS,PRODUCT_FIELDS,TEST_GSTIN,TEST_BANK,verifyBankAccount,setLoginGstin,riderCode,distKm,clockLabel,shopStatus};';
const T = await import('data:text/javascript,' + encodeURIComponent(src + exportLine));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + m); };

// ---- XSS / URL sanitisation ----
ok(T.safeUrl('javascript:alert(1)') === '', 'safeUrl blocks javascript:');
ok(T.safeUrl('JavaScript:alert(1)') === '', 'safeUrl blocks JavaScript: (mixed case)');
ok(T.safeUrl('  javascript:alert(1)') === '', 'safeUrl blocks leading-space javascript:');
ok(T.safeUrl('data:text/html,<script>x</script>') === '', 'safeUrl blocks data:text/html');
ok(T.safeUrl('vbscript:msgbox') === '', 'safeUrl blocks vbscript:');
ok(T.safeUrl('https://res.cloudinary.com/x.jpg') === 'https://res.cloudinary.com/x.jpg', 'safeUrl allows https');
ok(T.safeUrl('assets/logo.png') === 'assets/logo.png', 'safeUrl allows relative path');
ok(T.safeUrl('tel:+919881232966') === 'tel:+919881232966', 'safeUrl allows tel:');
ok(!T.jsStr("');alert(1)//").includes("');"), 'jsStr breaks out-of-string attempt');
ok(T.esc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', 'esc neutralises tags');
ok(T.esc(`"><svg onload=alert(1)>`).indexOf('<') === -1, 'esc neutralises attribute breakout');

// ---- password hashing ----
const rec = await T.hashPassword('Sup3rSecret!');
ok(rec.algo === 'pbkdf2-sha256' && rec.salt && rec.hash && !('password' in rec), 'hashPassword: salted hash, no plaintext field');
ok(await T.verifyPassword({ pw: rec }, 'Sup3rSecret!') === true, 'verifyPassword accepts correct password');
ok(await T.verifyPassword({ pw: rec }, 'wrong') === false, 'verifyPassword rejects wrong password');
ok(await T.verifyPassword({ password: 'legacy_plain_pw' }, 'legacy_plain_pw') === true, 'verifyPassword accepts legacy plaintext (migration path)');
ok(await T.verifyPassword({ password: 'legacy_plain_pw' }, 'nope') === false, 'verifyPassword rejects wrong legacy plaintext');
const r2 = await T.hashPassword('samePass1'); const r3 = await T.hashPassword('samePass1');
ok(r2.salt !== r3.salt && r2.hash !== r3.hash, 'unique salt per hash (no rainbow reuse)');
ok(T.timingSafeEqual('abc', 'abc') && !T.timingSafeEqual('abc', 'abd') && !T.timingSafeEqual('abc', 'abcd'), 'timingSafeEqual correct on equal/diff/len');

// ---- password strength ----
ok(!T.isStrongEnough('123456'), 'strength: rejects 123456');
ok(!T.isStrongEnough('password'), 'strength: rejects letters-only');
ok(!T.isStrongEnough('1234567'), 'strength: rejects short digits-only');
ok(T.isStrongEnough('abcd1234'), 'strength: accepts 8-char letter+digit');

// ---- throttle / brute-force ----
localStorage.clear();
for (let i = 0; i < 5; i++) { ok(T.throttleCheck('signin', '999') === null, 'signin attempt ' + (i + 1) + ' allowed'); T.throttleFail('signin', '999'); }
ok(T.throttleCheck('signin', '999') !== null, 'signin locks out after 5 fails');
ok(T.throttleCheck('signin', '888') === null, 'lockout is per-subject (other number unaffected)');
T.throttleReset('signin', '999');
ok(T.throttleCheck('signin', '999') === null, 'reset clears lockout (successful login recovers)');
// OTP guessing
localStorage.clear();
for (let i = 0; i < 5; i++) T.throttleFail('otpVerify', 'vid1');
ok(T.throttleCheck('otpVerify', 'vid1') !== null, 'otpVerify locks out after 5 guesses (4-digit brute-force blocked)');

// ---- GSTIN checksum ----
// Real, checksum-valid GSTINs from public GST records — these must pass, or
// the app would reject legitimate business signups.
ok(T.isWellFormedGSTIN('07AAGFF2194N1Z1'), 'real valid GSTIN passes checksum');
ok(T.isWellFormedGSTIN('27AAPFU0939F1ZV'), 'second real valid GSTIN passes checksum');
// The app's advertised TEST_GSTIN is NOT checksum-valid; it is handled by an
// early return in verifyGSTIN before the checksum runs, so it must correctly
// fail this structural check.
ok(!T.isWellFormedGSTIN('27AAPFM1234A1ZV'), 'app TEST_GSTIN fails checksum (handled by early-return, not this gate)');
ok(!T.isWellFormedGSTIN('27AAPFM1234A1ZZ'), 'wrong check digit fails');
ok(!T.isWellFormedGSTIN('nonsense'), 'garbage GSTIN fails');
ok(!T.isWellFormedGSTIN("27AAPFM1234A1ZV' OR '1'='1"), 'injection-style GSTIN fails');

// ---- mass-assignment / remote-config allowlist ----
const dirty = JSON.parse('{"businessName":"MD","evil":"x","minOrderValue":"2000","logo":"javascript:alert(1)","__proto__":{"polluted":true}}');
const clean = T.pickFields(dirty, T.APPCFG_FIELDS);
ok(!('evil' in clean), 'pickFields drops unknown config field');
ok(({}).polluted === undefined, 'no prototype pollution after pickFields');
ok(clean.minOrderValue === 2000, 'pickFields coerces numeric string to number');
ok(!('logo' in clean) || clean.logo === undefined, 'pickFields strips javascript: URL from logo');
const prod = T.pickFields({ name: 'X', cat: 'dairy', bogus: 1, variants: [{ id: 'v1', label: '1L', mrp: 50, b2b: 44, evil: 9 }] }, T.PRODUCT_FIELDS);
ok(!('bogus' in prod), 'product pickFields drops unknown field');
ok(prod.variants[0].evil === undefined, 'variant coercion drops unknown variant field');
ok(prod.variants[0].mrp === 50, 'variant coercion keeps real numeric field');

// ---- test bank account (demo builds) ----
T.setLoginGstin(T.TEST_GSTIN);
const tb = await T.verifyBankAccount(T.TEST_BANK.ifsc, T.TEST_BANK.account);
ok(tb.name === 'Test Business Pvt Ltd', 'test bank account verifies when paired with the test GSTIN');
T.setLoginGstin('27ABCDE1234F1Z5');
let tbErr = null; try { await T.verifyBankAccount(T.TEST_BANK.ifsc, T.TEST_BANK.account); } catch (e) { tbErr = e; }
ok(!!tbErr, 'test bank account is refused alongside any real GSTIN');
let realErr = null; try { await T.verifyBankAccount('HDFC0001234', '123456789012'); } catch (e) { realErr = e; }
ok(!!realErr && /not configured/.test(realErr.message), 'every other account still needs the real provider');
ok(T.APPCFG_FIELDS.rfdFee === 'num', 'driver-request charge is an allowed remote setting, numbers only');

// ---- rider delivery codes (the doc id riders open) ----
ok(T.riderCode('https://modern-dairy-pune.web.app/ride/#k7qmp-4xa9r') === 'K7QMP4XA9R', 'rider code: a whole pasted link reduces to the code');
ok(T.riderCode(' k7qmp 4xa9r ') === 'K7QMP4XA9R', 'rider code: spaces, dashes and case are ignored');
ok(T.riderCode('../orders/x"><img>') === 'ORDERSXIMG', 'rider code: only letters and digits survive (no path or markup)');
ok(Math.abs(T.distKm([18.5204, 73.8567], [19.0760, 72.8777]) - 120) < 5, 'rider distance: Pune to Mumbai comes out near 120 km');

// ---- shop hours: Mon–Sat 8–2 and 4–9, Sunday 8–2 (2026-09-14 is a Monday) ----
const at = (day, h, m = 0) => new Date(2026, 8, 13 + day, h, m);   // day 0 = Sunday 13 Sep
ok(T.shopStatus(at(1, 10)).open && T.shopStatus(at(1, 10)).text === 'Open till 2 PM', 'shop hours: Monday 10 AM is open till 2 PM');
ok(!T.shopStatus(at(1, 15)).open && T.shopStatus(at(1, 15)).text === 'Opens 4 PM', 'shop hours: Monday 3 PM is the break, opens 4 PM');
ok(T.shopStatus(at(1, 20, 30)).text === 'Open till 9 PM', 'shop hours: Monday 8:30 PM is open till 9 PM');
ok(T.shopStatus(at(1, 21, 30)).text === 'Opens 8 AM tomorrow', 'shop hours: Monday 9:30 PM opens 8 AM tomorrow');
ok(!T.shopStatus(at(0, 15)).open && T.shopStatus(at(0, 15)).text === 'Opens 8 AM tomorrow', 'shop hours: Sunday is a half day, shut at 3 PM');
ok(T.shopStatus(at(6, 21, 30)).text === 'Opens 8 AM tomorrow', 'shop hours: Saturday night rolls to Sunday 8 AM');
ok(T.clockLabel(8 * 60) === '8 AM' && T.clockLabel(14 * 60) === '2 PM' && T.clockLabel(12 * 60 + 30) === '12:30 PM', 'shop hours: clock labels read naturally');

console.log('\nFRONTEND PEN-TEST: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
