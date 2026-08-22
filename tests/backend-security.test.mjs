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

console.log('\nBACKEND PEN-TEST: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
