#!/usr/bin/env node
/**
 * APPLY-AUDIT-FIXES — the "Apply latest audit fixes & publish" button.
 *
 * Runs on a short schedule (+ manual dispatch). It only does anything when the
 * admin has clicked the button, which sets deploy_control/request.requested.
 *
 * When requested:
 *   1. Find the newest OPEN pull request whose branch is `nightly-audit/*`
 *      (these are the audit's proposed-fix PRs).
 *   2. Check it out, install deps, and RE-RUN THE TESTS (npm run test:security
 *      + the committed-secret scan). If anything fails, stop — do NOT merge or
 *      deploy — and report "tests failed"; the PR stays open for a human.
 *   3. If the tests pass: merge the PR to master. That merge push auto-triggers
 *      the normal APK build, so a fresh app build is produced.
 *   4. If a FIREBASE_TOKEN secret is present, deploy hosting + Firestore rules,
 *      so the admin site and rules go live on the web within minutes. (The
 *      native app can't be hot-updated; customers get the change on their next
 *      app update — an inherent Android limitation, not a bug.)
 *   5. Record the result on deploy_control/request and clear `requested`.
 *
 * SAFETY: a human clicks the button (per-click authorization), and the tests
 * gate the merge. It only ever merges a pull request the audit already
 * produced; it never writes code itself here.
 *
 * Secrets: FCM_SERVICE_ACCOUNT_JSON (Firestore, already set), GH_TOKEN
 * (automatic in Actions, for gh), and optionally FIREBASE_TOKEN (web deploy).
 */
'use strict';
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');

const PROJECT_ID = 'modern-dairy-pune';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const SCOPES = 'https://www.googleapis.com/auth/datastore';
const REPO_ROOT = path.join(__dirname, '..', '..');

function base64url(input) { return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return (await res.json()).access_token;
}
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('timestampValue' in v) return v.timestampValue;
  return null;
}
async function getDoc(token, docPath) {
  const res = await fetch(`${FIRESTORE_BASE}/${docPath}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get ${docPath} failed (${res.status})`);
  const d = await res.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromValue(v)]));
}
async function patchDoc(token, docPath, fields) {
  const [coll, ...rest] = docPath.split('/');
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FIRESTORE_BASE}/${encodeURIComponent(coll)}/${encodeURIComponent(rest.join('/'))}?${mask}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!res.ok) throw new Error(`patch ${docPath} failed (${res.status}): ${await res.text()}`);
}
function sh(cmd, opts = {}) { return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
function shOk(cmd) { try { sh(cmd); return true; } catch (e) { return false; } }

async function main() {
  const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.client_email) throw new Error('FCM_SERVICE_ACCOUNT_JSON is not set.');
  const token = await getAccessToken(sa);

  const req = (await getDoc(token, 'deploy_control/request')) || {};
  if (!req.requested) { console.log('No apply requested — nothing to do.'); return; }
  console.log('Apply requested by', req.requestedBy || 'admin');

  const finish = (result) => patchDoc(token, 'deploy_control/request', { requested: false, lastResult: result, lastAt: new Date().toISOString() });

  // 1. Newest open audit PR.
  let pr;
  try {
    const prs = JSON.parse(sh('gh pr list --state open --json number,headRefName,title --limit 50'));
    const audits = prs.filter(p => String(p.headRefName || '').startsWith('nightly-audit/')).sort((a, b) => b.number - a.number);
    pr = audits[0];
  } catch (e) { await finish('could not list PRs: ' + e.message.slice(0, 120)); return; }
  if (!pr) { console.log('No open audit fix PR found.'); await finish('no open audit fix PR to apply'); return; }
  console.log(`Applying PR #${pr.number}: ${pr.title}`);

  // 2. Check it out and re-run the tests.
  try { sh(`gh pr checkout ${pr.number}`); }
  catch (e) { await finish(`could not check out PR #${pr.number}`); return; }
  sh('npm ci --ignore-scripts');
  sh('cd backend && npm ci --ignore-scripts');
  const testsPass = shOk('npm run test:security') && shOk('node scripts/check-no-secrets.js') && shOk('node scripts/check-secrets-placeholder.js');
  if (!testsPass) {
    console.log('Tests FAILED on the PR — not merging.');
    sh('git checkout master');
    await finish(`tests failed on PR #${pr.number} — not applied (left open for review)`);
    return;
  }
  console.log('Tests pass.');

  // 3. Merge to master (auto-triggers the APK build via push).
  sh('git config user.email "audit-bot@users.noreply.github.com"');
  sh('git config user.name "Nightly Audit Bot"');
  try { sh(`gh pr merge ${pr.number} --squash --delete-branch`); }
  catch (e) { await finish(`merge failed on PR #${pr.number}: ${e.message.slice(0, 120)}`); return; }
  console.log(`Merged PR #${pr.number}. APK build will run from the merge.`);

  // 4. Deploy web (hosting + rules) if a Firebase token is configured.
  let webNote = 'web deploy skipped (no FIREBASE_TOKEN)';
  if (process.env.FIREBASE_TOKEN) {
    sh('git checkout master && git pull --ff-only');
    const ok = shOk(`npx --yes firebase-tools deploy --only hosting,firestore:rules --project ${PROJECT_ID} --token ${process.env.FIREBASE_TOKEN} --non-interactive`);
    webNote = ok ? 'web (site + rules) deployed' : 'web deploy attempted but failed — check the run log';
  }
  console.log(webNote);

  await finish(`applied PR #${pr.number}; ${webNote}; new app build triggered`);
  console.log('Done.');
}

main().catch(async (e) => {
  console.error('apply-audit-fixes failed:', e);
  try {
    const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
    const token = await getAccessToken(sa);
    await patchDoc(token, 'deploy_control/request', { requested: false, lastResult: 'error: ' + String(e.message || e).slice(0, 150), lastAt: new Date().toISOString() });
  } catch (_) {}
  process.exit(1);
});
