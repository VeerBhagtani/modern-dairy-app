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
 *      + the committed-secret scan).
 *   3. Record the outcome on deploy_control/request and clear `requested`, so
 *      the admin panel shows whether the fix PR passed its tests.
 *
 * IT DOES NOT MERGE AND DOES NOT DEPLOY. Per the maintenance baseline,
 * automation must never merge its own PR or push AI-authored changes to
 * production behind only a thin test gate. This job just validates the fix PR
 * and hands it back for a human to review the diff and merge on GitHub.
 *
 * Secrets: FCM_SERVICE_ACCOUNT_JSON (Firestore, already set), GH_TOKEN
 * (automatic in Actions, for gh). It does not merge or deploy, so no Firebase/deploy token is needed.
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

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    require('fs').appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(`${key}=${value}`);
}

/* PHASE 1 — decide whether there is anything to do, and which PR.
   Runs with the service account but executes none of the PR's code. */
async function select() {
  const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.client_email) throw new Error('FCM_SERVICE_ACCOUNT_JSON is not set.');
  const token = await getAccessToken(sa);

  const req = (await getDoc(token, 'deploy_control/request')) || {};
  if (!req.requested) {
    console.log('No apply requested — nothing to do.');
    setOutput('requested', 'false');
    setOutput('pr', '');
    return;
  }
  console.log('Apply requested by', req.requestedBy || 'admin');
  setOutput('requested', 'true');

  let pr = null;
  try {
    const prs = JSON.parse(sh('gh pr list --state open --json number,headRefName,title --limit 50'));
    // The branch-name filter picks the INTENDED PR; it is not a security
    // control, because a fork can name its branch anything. What makes running
    // this PR's code safe is that the job which runs it holds no secrets.
    const audits = prs
      .filter((p) => String(p.headRefName || '').startsWith('nightly-audit/'))
      .sort((a, b) => b.number - a.number);
    pr = audits[0] || null;
  } catch (e) {
    await patchDoc(token, 'deploy_control/request', {
      requested: false,
      lastResult: 'could not list PRs: ' + e.message.slice(0, 120),
      lastAt: new Date().toISOString(),
    });
    setOutput('pr', '');
    return;
  }

  if (!pr) {
    console.log('No open audit fix PR found.');
    await patchDoc(token, 'deploy_control/request', {
      requested: false,
      lastResult: 'no open audit fix PR to apply',
      lastAt: new Date().toISOString(),
    });
    setOutput('pr', '');
    return;
  }
  console.log(`Selected PR #${pr.number}: ${pr.title}`);
  setOutput('pr', String(pr.number));
}

/* PHASE 3 — write the outcome back. Holds the service account; never checks
   out or runs the pull request's code.
   VALIDATE ONLY: automation must not merge its own PR or push to production.
   AI-authored changes gated by a thin (security-only) test suite must not
   reach the live website, the rules, or master without a human reading the
   diff. This records a verdict and stops. */
async function report() {
  const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON || '{}');
  if (!sa.client_email) throw new Error('FCM_SERVICE_ACCOUNT_JSON is not set.');
  const token = await getAccessToken(sa);

  const pr = process.env.AUDIT_PR || '';
  const passed = process.env.AUDIT_TESTS_PASSED;

  let result;
  if (!pr) {
    result = 'no open audit fix PR to apply';
  } else if (passed === 'true') {
    result = `PR #${pr} passed the tests and is READY FOR YOUR REVIEW — open it on GitHub, read the diff, and merge it yourself if it's good. (Automation does not merge or deploy.)`;
  } else if (passed === 'false') {
    result = `tests failed on PR #${pr} — not applied (left open for review)`;
  } else {
    // The test job errored or was skipped rather than reporting a verdict.
    result = `could not complete the test run for PR #${pr} — check the workflow logs`;
  }

  await patchDoc(token, 'deploy_control/request', {
    requested: false,
    lastResult: result,
    lastAt: new Date().toISOString(),
  });
  console.log(result);
}

const mode = process.argv.includes('--report') ? 'report'
  : process.argv.includes('--select') ? 'select'
  : null;

if (!mode) {
  console.error('Usage: apply-audit-fixes.js --select | --report');
  console.error('These run as SEPARATE GitHub Actions jobs so that the pull request\'s own');
  console.error('code never executes in a job that holds FCM_SERVICE_ACCOUNT_JSON.');
  process.exit(2);
}

(mode === 'select' ? select() : report()).catch(async (e) => {
  console.error('apply-audit-fixes failed:', e);
  try {
    const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
    const token = await getAccessToken(sa);
    await patchDoc(token, 'deploy_control/request', { requested: false, lastResult: 'error: ' + String(e.message || e).slice(0, 150), lastAt: new Date().toISOString() });
  } catch (_) {}
  process.exit(1);
});
