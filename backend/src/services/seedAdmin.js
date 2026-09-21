/* Create the first office login on startup, once, if it is missing.
 *
 * Why here and not in the deploy: the deploy's service account can manage
 * Firestore indexes but cannot write documents, and widening it would mean
 * handing the CI credential read/write access to every driver's location
 * history for the sake of one row. The service itself already has the access
 * it needs, so the seed belongs where the access already is.
 *
 * The hash arrives as an environment variable set by the deploy. It is a
 * bcrypt hash of a long random password, which is safe to carry in plain sight;
 * the plaintext went to the owner privately and the dashboard makes them
 * replace it at first sign-in.
 *
 * Three things this must never do:
 *   - overwrite an existing account, so a changed password survives a redeploy
 *   - accept anything that is not a bcrypt hash as a password
 *   - stop the service from starting if Firestore is slow or unhappy
 */
'use strict';
const { db } = require('./firestore');

const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

async function seedAdminIfMissing({
  username = process.env.SEED_ADMIN_USERNAME,
  passwordHash = process.env.SEED_ADMIN_HASH,
  name = process.env.SEED_ADMIN_NAME || username,
} = {}) {
  if (!username || !passwordHash) return { seeded: false, reason: 'not configured' };
  // "." and ".." pass the character class but are not legal Firestore document
  // ids, so they are rejected by name — the same guard the login path uses.
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(username) || username === '.' || username === '..') {
    return { seeded: false, reason: 'invalid username' };
  }
  if (!BCRYPT.test(passwordHash)) return { seeded: false, reason: 'not a bcrypt hash' };

  const ref = db.collection('admins').doc(username);
  const existing = await ref.get();
  if (existing.exists) return { seeded: false, reason: 'already exists' };

  // create() rather than set(): if two instances start at once, the second
  // fails instead of overwriting the first.
  try {
    await ref.create({
      name,
      role: 'admin',
      passwordHash,
      status: 'active',
      mustChangePassword: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: 'startup:seed',
    });
  } catch (e) {
    if (e && e.code === 6) return { seeded: false, reason: 'already exists' };  // ALREADY_EXISTS
    throw e;
  }
  return { seeded: true };
}

// Fire and forget at boot. A failure here must never take the service down —
// the office not being able to sign in is a problem; forty phones not being
// able to report their position is a worse one.
function seedAdminOnStartup() {
  seedAdminIfMissing()
    .then((r) => {
      if (r.seeded) console.log(`Seeded the office login "${process.env.SEED_ADMIN_USERNAME}".`);
      else console.log(`Office login not seeded: ${r.reason}.`);
    })
    .catch((e) => console.error('Could not seed the office login:', e.message));
}

module.exports = { seedAdminIfMissing, seedAdminOnStartup };
