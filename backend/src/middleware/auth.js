const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { getSecret } = require('../services/secretManager');
const { col, db, FieldValue, expiryAt } = require('../services/firestore');

const ACCESS_TTL = '15m';
const REFRESH_TTL = '30d';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function signingKey() {
  const key = await getSecret('jwt-signing-key');
  if (!key) throw new Error('jwt-signing-key not configured in Secret Manager — run the deploy setup step that generates it.');
  return key;
}

/* ── Refresh tokens are rotating, single-use, and revocable ────────────────
   They used to be none of those things: a plain 30-day bearer JWT with no
   jti, nothing stored server-side, and no way to invalidate one. A token
   captured once was good for a month, and "sign out" only wiped it from the
   device while it stayed valid for whoever else held a copy.

   Now every refresh token carries a jti (this exact token) and a fam (the
   login session it descends from). refresh_tokens/{jti} exists for exactly as
   long as that token is usable, and using it deletes it and mints the next
   one in the same family.

   Reuse detection falls out of that for free: if a presented token verifies
   cryptographically but its jti document is gone, the token was already spent
   — which means two parties hold it, and one of them is not the customer. The
   safe reading is theft, so the entire family is revoked and both are forced
   to sign in again. A customer losing one session beats an attacker keeping a
   month of access. */
async function issueTokens(user, { rotatedFrom = null } = {}) {
  const key = await signingKey();
  const fam = rotatedFrom?.fam || uuid();
  const jti = uuid();

  const accessToken = jwt.sign({ sub: user.id, type: 'access' }, key, { expiresIn: ACCESS_TTL, algorithm: 'HS256' });
  const refreshToken = jwt.sign({ sub: user.id, type: 'refresh', jti, fam }, key, { expiresIn: REFRESH_TTL, algorithm: 'HS256' });

  await col.refreshTokens().doc(jti).set({
    sub: user.id,
    fam,
    expiresAt: expiryAt(REFRESH_TTL_MS),
    issuedAt: FieldValue.serverTimestamp(),
  });
  return { accessToken, refreshToken };
}

// Deletes every live token in a family. Used on logout and on reuse detection.
async function revokeFamily(fam) {
  if (!fam) return;
  const snap = await col.refreshTokens().where('fam', '==', fam).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete().catch(() => {})));
}

async function revokeRefreshToken(payload) {
  await revokeFamily(payload?.fam);
}

async function verifyToken(token, expectedType) {
  const key = await signingKey();
  // Pin the accepted algorithm explicitly — never trust the algorithm named
  // in the token's own header (classic JWT "alg confusion" mitigation).
  const payload = jwt.verify(token, key, { algorithms: ['HS256'] });
  if (payload.type !== expectedType) throw new Error('wrong token type');

  if (expectedType === 'refresh') {
    // Consume it. The read and the delete are one transaction so two
    // simultaneous refreshes cannot both succeed — exactly one wins, and the
    // loser is treated as reuse, which is the correct reading when a token is
    // genuinely single-use.
    const ref = col.refreshTokens().doc(String(payload.jti || ''));
    const live = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return false;
      t.delete(ref);
      return true;
    });
    if (!live) {
      await revokeFamily(payload.fam);
      throw new Error('refresh token reuse detected');
    }
  }
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

module.exports = { issueTokens, verifyToken, requireAuth, revokeRefreshToken, revokeFamily };
