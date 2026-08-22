const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getSecret } = require('../services/secretManager');
const { db } = require('../services/firestore');

const ADMIN_TOKEN_TTL = '4h';

async function signingKey() {
  const key = await getSecret('jwt-signing-key');
  if (!key) throw new Error('jwt-signing-key not configured in Secret Manager.');
  return key;
}

async function issueAdminToken(adminId) {
  const key = await signingKey();
  return jwt.sign({ sub: adminId, type: 'admin' }, key, { expiresIn: ADMIN_TOKEN_TTL, algorithm: 'HS256' });
}

// A bcrypt hash of a value nobody knows, used only to burn the same CPU time
// for a non-existent admin as for a real one. Without it this function
// returned immediately when the document was missing but spent ~100ms of
// bcrypt work when it existed — a clean timing oracle for "is this a real
// admin username?", which is the first half of a targeted brute-force.
const DUMMY_HASH = bcrypt.hashSync(require('crypto').randomBytes(32).toString('hex'), 10);

async function verifyAdminLogin(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  // Firestore doc ids can't contain '/' and mustn't be '.'/'..'; reject
  // anything that isn't a plain id rather than building a path from it.
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(username) || username === '.' || username === '..') {
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }
  const doc = await db.collection('admins').doc(username).get();
  const data = doc.exists ? doc.data() : null;
  const hash = (data && typeof data.passwordHash === 'string') ? data.passwordHash : DUMMY_HASH;
  const ok = await bcrypt.compare(password, hash);
  if (!data || !ok) return null;
  // Return only what a caller needs. Spreading the whole document here meant
  // passwordHash travelled with the "admin" object; nothing echoes it today,
  // but a hash should never be one careless res.json() away from the wire.
  const { passwordHash, ...safe } = data;
  return { id: username, ...safe };
}

function requireAdmin() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ success: false, message: 'Missing admin token' });
      const key = await signingKey();
      const payload = jwt.verify(token, key, { algorithms: ['HS256'] });
      if (payload.type !== 'admin') return res.status(403).json({ success: false, message: 'Not an admin token' });
      req.adminId = payload.sub;
      next();
    } catch (e) {
      res.status(401).json({ success: false, message: 'Invalid or expired admin token' });
    }
  };
}

module.exports = { issueAdminToken, verifyAdminLogin, requireAdmin };
