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

async function verifyAdminLogin(username, password) {
  const doc = await db.collection('admins').doc(username).get();
  if (!doc.exists) return null;
  const data = doc.data();
  const ok = await bcrypt.compare(password, data.passwordHash);
  return ok ? { id: username, ...data } : null;
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
