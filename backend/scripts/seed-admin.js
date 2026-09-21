#!/usr/bin/env node
/* Seed the first office login, from a password hash rather than a password.
 *
 *   node scripts/seed-admin.js --user Modern-dairy --name "Modern Dairy" --hash '$2a$12$...'
 *
 * Why a hash: this repository is public, so a password committed to it — or
 * printed in a build log, or passed as a workflow input — is a published
 * password. A bcrypt hash of a long random password is not: it cannot be
 * reversed and cannot be guessed, which is exactly what hashes are for. The
 * plaintext is handed to the owner out of band, and the Change Password screen
 * in the dashboard lets them replace it with one of their own.
 *
 * It never overwrites an existing account. Once that password has been changed,
 * re-running the deploy must not put the seeded one back.
 */
'use strict';
const { db } = require('../src/services/firestore');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const username = arg('user');
const name = arg('name', username);
const role = arg('role', 'admin');
const passwordHash = arg('hash');

if (!username || !/^[A-Za-z0-9_.@-]{1,128}$/.test(username)) {
  console.error('A valid --user is required.');
  process.exit(1);
}
if (!passwordHash || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
  console.error('--hash must be a bcrypt hash. Refusing to store anything else as a password.');
  process.exit(1);
}
if (!['admin', 'manager', 'viewer'].includes(role)) {
  console.error(`Unknown role "${role}".`);
  process.exit(1);
}

(async () => {
  const ref = db.collection('admins').doc(username);
  const existing = await ref.get();
  if (existing.exists) {
    console.log(`Office login "${username}" already exists — left exactly as it is.`);
    process.exit(0);
  }
  await ref.set({
    name,
    role,
    passwordHash,
    status: 'active',
    mustChangePassword: true,   // the dashboard nags until it is replaced
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: 'deploy:seed',
  });
  console.log(`Created office login "${username}" with the ${role} role.`);
})().catch((e) => { console.error(e); process.exit(1); });
