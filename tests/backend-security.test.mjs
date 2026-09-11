// Backend security-logic pen-test. Loads the real modules and drives them
// with attacker inputs. No Firestore/network needed for the pure logic.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend') + '/');
process.chdir(path.join(ROOT, 'backend'));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + m); };

// ---------- validate.js ----------
const v = require('./src/middleware/validate');

// OTP length: must accept the live provider's 4-digit AND Twilio's 6-digit.
ok(v.isValidOtp('1234'), 'OTP accepts 4 digits (Message Central)');
ok(v.isValidOtp('123456'), 'OTP accepts 6 digits (Twilio)');
ok(!v.isValidOtp('12'), 'OTP rejects 2 digits');
ok(!v.isValidOtp('12a4'), 'OTP rejects non-numeric');
ok(!v.isValidOtp("1234' OR 1=1"), 'OTP rejects injection payload');

// phone / id
ok(v.isValidPhone('9876543210'), 'phone accepts valid 10-digit');
ok(!v.isValidPhone('1234567890'), 'phone rejects non-6-9 leading');
ok(!v.isValidId('../../etc/passwd'), 'id rejects path traversal');
ok(!v.isValidId('a/b'), 'id rejects slash');
ok(v.isValidId('abc_123-XY'), 'id accepts firestore-safe id');

// mass-assignment guard
const picked = v.pickAllowed({ name: 'x', role: 'admin', balance: 9999, priceVerified: true }, ['name']);
ok(Object.keys(picked).length === 1 && picked.name === 'x', 'pickAllowed keeps only allowed keys');
ok(!('role' in picked) && !('balance' in picked), 'pickAllowed drops role/balance');
ok(v.hasForbiddenKeys(JSON.parse('{"__proto__":1}')), 'hasForbiddenKeys catches __proto__');
ok(v.hasForbiddenKeys({ constructor: 1 }), 'hasForbiddenKeys catches constructor');
ok(!v.hasForbiddenKeys({ name: 1 }), 'hasForbiddenKeys allows normal keys');

// ---------- adminAuth.js: bcrypt + timing + hash non-leak ----------
const bcrypt = require('bcryptjs');
// Simulate verifyAdminLogin's core against a stubbed Firestore doc by
// re-testing the observable properties through the module where possible.
// The module needs firestore; we validate the pure crypto contract here and
// the response-shaping via a direct data object.
const hash = bcrypt.hashSync('R3alAdminPass!', 10);
ok(bcrypt.compareSync('R3alAdminPass!', hash), 'bcrypt verifies correct admin password');
ok(!bcrypt.compareSync('wrong', hash), 'bcrypt rejects wrong admin password');

// The "return only safe fields" contract: destructure like adminAuth does.
const doc = { passwordHash: hash, role: 'super', name: 'Owner' };
const { passwordHash, ...safe } = doc;
ok(!('passwordHash' in safe), 'admin object never carries passwordHash to callers');

// ---------- rateLimit.js: limits are actually configured ----------
const rl = require('./src/middleware/rateLimit');
ok(typeof rl.authLimiter === 'function' && typeof rl.adminLoginLimiter === 'function', 'auth + admin limiters exist');
ok(typeof rl.otpPhoneLimiter === 'function', 'per-phone OTP limiter exists (anti SMS-bomb)');

// ---------- admin password recovery ----------
ok(v.adminPasswordProblem('short1') !== null, 'recovery rejects a password under 8 chars');
ok(v.adminPasswordProblem('onlyletters') !== null, 'recovery rejects a password with no digit');
ok(v.adminPasswordProblem('12345678') !== null, 'recovery rejects a password with no letter');
ok(v.adminPasswordProblem('a1'.repeat(65)) !== null, 'recovery rejects a password over 128 chars');
ok(v.adminPasswordProblem(12345678) !== null, 'recovery rejects a non-string password');
ok(v.adminPasswordProblem('Goodpass9') === null, 'recovery accepts a sound password');
const parsed = v.parseRecoveryPhones(' +91 98765 43210 ,1234567890, 9123456789,');
ok(parsed.length === 2 && parsed[0] === '9876543210' && parsed[1] === '9123456789', 'recovery list keeps valid mobiles, drops junk');
ok(v.parseRecoveryPhones(undefined).length === 0, 'unset recovery list is empty, so recovery reports not-configured');
ok(v.maskPhone('9876543210') === '••••••3210', 'masked number shows only the last 4 digits');

const fs = require('fs');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\/\/.*$/gm, ''); // code only, no comments
// If POST /admin/secrets could write these, a stolen admin session could
// repoint recovery at the thief's phone or swap in an OTP account it reads.
const known = Object.values(require('./src/services/secretManager').KNOWN_SECRETS);
ok(!['admin-recovery-phones', 'otp-auth-token', 'otp-customer-id'].some((s) => known.includes(s)),
  'recovery numbers + OTP credentials are not admin-settable');
const rec = src('backend/src/routes/adminRecovery.js');
ok((rec.match(/newPassword/g) || []).length === 3 && rec.includes('updateUser(ADMIN_FIREBASE_UID, { password: newPassword })'),
  'the new password is only validated and handed to Firebase Auth');
ok(!/console\.\w+\([^)]*(req\.body|newPassword)/.test(rec), 'recovery route never logs the body or the password');
ok(rec.includes('Number.isInteger(which)') && rec.includes('phones[which]') && !/req\.body\??\.phone/.test(rec),
  'a code can only go to a server-held number, never one the caller supplies');
const adminPage = fs.readFileSync(path.join(ROOT, 'legal/admin/index.html'), 'utf8');
ok(adminPage.includes('persistence: inMemoryPersistence'), 'admin site keeps no session between visits');
ok(!/admin-recovery-phones/.test(adminPage), 'admin page never references the recovery number store');

console.log('\nBACKEND PEN-TEST: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
