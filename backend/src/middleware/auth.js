const jwt = require('jsonwebtoken');
const { getSecret } = require('../services/secretManager');

const ACCESS_TTL = '15m';
const REFRESH_TTL = '30d';

async function signingKey() {
  const key = await getSecret('jwt-signing-key');
  if (!key) throw new Error('jwt-signing-key not configured in Secret Manager — run the deploy setup step that generates it.');
  return key;
}

async function issueTokens(user) {
  const key = await signingKey();
  const accessToken = jwt.sign({ sub: user.id, type: 'access' }, key, { expiresIn: ACCESS_TTL });
  const refreshToken = jwt.sign({ sub: user.id, type: 'refresh' }, key, { expiresIn: REFRESH_TTL });
  return { accessToken, refreshToken };
}

async function verifyToken(token, expectedType) {
  const key = await signingKey();
  const payload = jwt.verify(token, key);
  if (payload.type !== expectedType) throw new Error('wrong token type');
  return payload;
}

// Attaches req.userId. Customer-facing routes only — not for /admin/*.
function requireAuth() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ success: false, message: 'Missing access token' });
      const payload = await verifyToken(token, 'access');
      req.userId = payload.sub;
      next();
    } catch (e) {
      res.status(401).json({ success: false, message: 'Invalid or expired access token' });
    }
  };
}

module.exports = { issueTokens, verifyToken, requireAuth };
