// Office (admin) authentication.
//
// Username and password, verified here, exchanged for a short-lived JWT. No
// Firebase Auth: this service is a separate product from the ordering app and
// should not inherit its identity system, and one fewer thing to configure is
// one fewer thing to get wrong during setup.
//
// Admin accounts live in Firestore at admins/{username} and are created with
// `npm run create-admin` — there is no self-service signup, because there are
// only ever a handful of office staff and an open signup on a system holding
// live location data would be indefensible.

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getSecret } = require('../services/secretManager');
const { db } = require('../services/firestore');

const TOKEN_TTL = '8h';   // an office shift, so nobody is signed out mid-review

const ROLES = { viewer: 1, manager: 2, admin: 3 };

async function signingKey() {
  const key = await getSecret('jwt-signing-key');
  if (!key) throw new Error('jwt-signing-key is not configured in Secret Manager.');
  return key;
}

async function issueAdminToken(adminId, role) {
  const key = await signingKey();
  return jwt.sign({ sub: adminId, role, type: 'admin' }, key, { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}

// A bcrypt hash of a value nobody knows. Comparing against it for a username
// that does not exist burns the same CPU time as a real check, so response
// timing cannot be used to discover which usernames are real — the first half
// of any targeted brute force.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);

async function verifyLogin(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  // A Firestore document id cannot contain '/' and must not be '.' or '..'.
  // Reject anything that is not a plain id rather than building a path from it.
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(username) || username === '.' || username === '..') {
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }
  const doc = await db.collection('admins').doc(username).get();
  const data = doc.exists ? doc.data() : null;
  const hash = data && typeof data.passwordHash === 'string' ? data.passwordHash : DUMMY_HASH;
  const ok = await bcrypt.compare(password, hash);
  if (!data || !ok) return null;
  if (data.status === 'disabled') return null;
  return { id: username, role: ROLES[data.role] ? data.role : 'viewer', name: data.name || username };
}

// POST /admin/login
async function adminLoginHandler(req, res) {
  const { username, password } = req.body || {};
  const admin = await verifyLogin(username, password);
  // One message for both a wrong username and a wrong password — anything more
  // specific tells an attacker which half they got right.
  if (!admin) return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
  const token = await issueAdminToken(admin.id, admin.role);
  res.json({ success: true, data: { token, admin: { id: admin.id, name: admin.name, role: admin.role } } });
}

function requireAdmin() {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Sign in to continue.' });
    try {
      const key = await signingKey();
      // Algorithm pinned: never trust the alg named in the token's own header.
      const payload = jwt.verify(token, key, { algorithms: ['HS256'] });
      if (payload.type !== 'admin') return res.status(403).json({ success: false, message: 'Not an admin token' });
      req.adminId = payload.sub;
      req.adminRole = ROLES[payload.role] ? payload.role : 'viewer';
      return next();
    } catch {
      return res.status(401).json({ success: false, message: 'Your session has expired. Sign in again.' });
    }
  };
}

module.exports = { ROLES, issueAdminToken, verifyLogin, adminLoginHandler, requireAdmin };
