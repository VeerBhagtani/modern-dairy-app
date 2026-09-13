#!/usr/bin/env node
/**
 * Grants (or revokes) the `admin: true` custom claim on a Firebase Auth user.
 *
 * WHY THIS EXISTS
 * firestore.rules used to identify the admin by one hardcoded uid literal. That
 * meant the single account worth attacking was named in a public repo, adding a
 * second admin required editing and redeploying rules, and revoking one was the
 * same. isAdmin() now accepts `request.auth.token.admin == true` as well, and
 * this is how that claim gets set — there is no console UI for custom claims.
 *
 * The uid literal is still in the rules as a fallback so that deploying them
 * cannot lock the existing admin out before the claim exists. Once this script
 * has run and you have confirmed the claim works, delete that literal from
 * isAdmin() and redeploy: that is what actually removes the published target.
 *
 * USAGE
 *   # Point at a service account with Firebase Auth admin rights:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   export GCP_PROJECT_ID=modern-dairy-pune
 *
 *   node backend/scripts/set-admin-claim.js --email you@admin.local
 *   node backend/scripts/set-admin-claim.js --uid 63cH4Dduh4WS7okdV0s0DcJtD7q2
 *   node backend/scripts/set-admin-claim.js --email you@admin.local --revoke
 *   node backend/scripts/set-admin-claim.js --list          # who is an admin?
 *
 * The user must sign out and back in (or refresh their ID token) before a
 * changed claim takes effect — this script forces that by revoking their
 * refresh tokens, so the change is immediate rather than up to an hour later.
 */
'use strict';
const admin = require('firebase-admin');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : (process.argv[i + 1] || true);
}
const has = (name) => process.argv.includes('--' + name);

async function main() {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('Set GCP_PROJECT_ID (e.g. modern-dairy-pune).');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_CONFIG) {
    console.warn('No GOOGLE_APPLICATION_CREDENTIALS set — relying on ambient credentials.');
  }
  admin.initializeApp({ projectId });

  if (has('list')) {
    // Small user base; one page is plenty. Says plainly if nobody has it yet.
    const res = await admin.auth().listUsers(1000);
    const admins = res.users.filter((u) => u.customClaims && u.customClaims.admin === true);
    if (!admins.length) {
      console.log('No user carries admin:true yet. The rules are still relying on the uid fallback in isAdmin().');
    } else {
      console.log('Users with admin:true —');
      for (const u of admins) console.log(`  ${u.uid}  ${u.email || '(no email)'}`);
    }
    return;
  }

  const email = arg('email');
  const uid = arg('uid');
  if (!email && !uid) throw new Error('Pass --email or --uid (or --list).');

  const user = uid
    ? await admin.auth().getUser(String(uid))
    : await admin.auth().getUserByEmail(String(email));

  const revoke = has('revoke');
  // Preserve any other claims that may exist rather than overwriting the map.
  const existing = user.customClaims || {};
  const next = { ...existing };
  if (revoke) delete next.admin; else next.admin = true;

  await admin.auth().setCustomUserClaims(user.uid, next);
  // Without this the old ID token keeps its old claims for up to an hour —
  // which for a REVOKE means the removed admin stays an admin meanwhile.
  await admin.auth().revokeRefreshTokens(user.uid);

  console.log(`${revoke ? 'Revoked' : 'Granted'} admin for ${user.email || user.uid} (uid ${user.uid}).`);
  console.log('Their sessions were revoked; they must sign in again for it to take effect.');
  if (!revoke) {
    console.log('\nNext: confirm the admin website still works, then remove the hardcoded uid');
    console.log('from isAdmin() in backend/firestore.rules and redeploy the rules.');
  }
}

main().catch((e) => { console.error('set-admin-claim failed:', e.message); process.exit(1); });
