#!/usr/bin/env node
/* Create or update an office login.
 *
 * There is no self-service signup for the dashboard — a handful of office staff
 * use it, and an open registration form on a system holding live location data
 * would be indefensible. Accounts are made here, deliberately.
 *
 *   npm run create-admin -- --user veer --name "Veer" --role admin
 *
 * The password is read from the terminal without echoing, and only its bcrypt
 * hash is ever stored.
 *
 * Roles:
 *   viewer   read only
 *   manager  everything a viewer can do, plus stop rides and review journeys
 *   admin    everything, including thresholds and driver accounts
 */
'use strict';
const bcrypt = require('bcryptjs');
const readline = require('readline');
const { db } = require('../src/services/firestore');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const username = arg('user');
const name = arg('name', username);
const role = arg('role', 'admin');

if (!username || !/^[A-Za-z0-9_.@-]{1,128}$/.test(username)) {
  console.error('Usage: npm run create-admin -- --user <username> [--name "Full Name"] [--role admin|manager|viewer]');
  process.exit(1);
}
if (!['admin', 'manager', 'viewer'].includes(role)) {
  console.error(`Unknown role "${role}". Use admin, manager or viewer.`);
  process.exit(1);
}

function askPassword(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress the echo so the password does not end up in a screen recording
    // or someone's scrollback.
    const onData = (char) => {
      if (['\n', '\r', '\u0004'].includes(char.toString())) process.stdin.removeListener('data', onData);
      else process.stdout.write('\x1b[2K\x1b[200D' + prompt + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  // ADMIN_PASSWORD lets the deploy create this account with nobody at a
  // terminal. It is read from the environment rather than from an argument on
  // purpose: arguments are visible to anyone who can list processes and they
  // land in shell history. In CI it comes from a repository secret, which is
  // masked in the logs — never from a commit and never from a workflow input,
  // both of which are public on a public repository.
  const fromEnv = process.env.ADMIN_PASSWORD;
  const password = fromEnv || await askPassword('Password: ');
  if (password.length < 10) {
    console.error('\nUse at least 10 characters. This account can see where every driver is.');
    process.exit(1);
  }
  if (!fromEnv) {
    const again = await askPassword('Again:    ');
    if (password !== again) {
      console.error('\nThe two passwords do not match.');
      process.exit(1);
    }
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const ref = db.collection('admins').doc(username);
  const existed = (await ref.get()).exists;
  await ref.set({
    name, role, passwordHash, status: 'active',
    updatedAt: Date.now(),
    ...(existed ? {} : { createdAt: Date.now() }),
  }, { merge: true });

  console.log(`\n${existed ? 'Updated' : 'Created'} office login "${username}" with the ${role} role.`);
  console.log('Sign in at the dashboard with that username and password.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
