#!/usr/bin/env node
/**
 * NIGHTLY AUDIT RUNNER — runs on a schedule (see
 * .github/workflows/nightly-audit.yml, ~3 AM IST) and only does real work when
 * the admin has armed it via the admin panel's "Schedule audit tonight" button.
 *
 * Flow when armed (audit_control/schedule.requested == true):
 *   1. Put the app under maintenance (app_config.maintenanceMode = true) so
 *      customers can't use it while it's being audited.
 *   2. Pick the NEXT audit focus after the last one (rotating list below), so
 *      each night looks at the app from a different angle.
 *   3. Run the deterministic checks that CI can actually do headlessly:
 *      security-test suite, backend test suite, `npm audit`, and the
 *      committed-secret scan — capturing pass/fail + output.
 *   4. Ask Claude Opus 5 to do a focused code review of that night's area,
 *      grounded in the repo source + the check results, and return a concrete
 *      bug list with severities and suggested fixes (JSON).
 *   5. Write the whole thing to Firestore: one `audits/<runId>` document with
 *      the full report, and one summary entry per finding into `maintenance_log`
 *      so it shows in the admin "Maintenance" tab for review.
 *   6. Take the app back OUT of maintenance and disarm the schedule, recording
 *      lastAuditType / lastAuditAt so tomorrow's run rotates to the next area.
 *
 * DELIBERATE SAFETY BOUNDARY: this reports bugs and proposed fixes for a human
 * to review — it does NOT edit code or deploy. Letting an unattended job rewrite
 * and publish a live app is exactly the kind of thing the rest of this repo was
 * hardened against. (An opt-in "open a draft PR with the fixes" step can be
 * added later; a draft PR is safe because it changes nothing until a human
 * merges it.)
 *
 * Secrets it needs (GitHub Actions):
 *   - FCM_SERVICE_ACCOUNT_JSON : already present; used here to read/write
 *     Firestore as the service account (bypasses client rules).
 *   - ANTHROPIC_API_KEY        : the Claude key for the Opus review. If absent,
 *     the deterministic checks still run and get reported; only the AI review
 *     is skipped (clearly noted in the report).
 */
'use strict';
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'modern-dairy-pune';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const SCOPES = 'https://www.googleapis.com/auth/datastore';
const REPO_ROOT = path.join(__dirname, '..', '..');
const MODEL = 'claude-opus-5';

// Must match AUDIT_TYPES in legal/admin/index.html.
const AUDIT_TYPES = [
  { id: 'security',       label: 'Security & auth',
    focus: 'authentication/authorization, secret handling, injection/XSS, Firestore rules, session and password handling.' },
  { id: 'functionality',  label: 'Features & flows',
    focus: 'core user journeys (signup/login/OTP, catalogue, cart, checkout, order tracking, wallet, admin actions) — correctness and broken/edge-case behaviour.' },
  { id: 'data-integrity', label: 'Data & money integrity',
    focus: 'price/total/GST/MOQ math, order and wallet integrity, the price-verification cron, and anywhere client-supplied numbers are trusted.' },
  { id: 'performance',    label: 'Performance & size',
    focus: 'render/paint cost, repeated network fetches, unbounded loops or lists, payload/APK size, and anything that would be slow on a cheap Android phone.' },
  { id: 'ui-ux',          label: 'UI / UX & accessibility',
    focus: 'confusing flows, unreachable states, missing loading/error states, contrast/tap-target/accessibility issues, and copy that would confuse a real customer.' },
  { id: 'code-quality',   label: 'Code quality & robustness',
    focus: 'error handling, dead/duplicated code, fragile assumptions, missing input validation, and maintainability risks.' },
  { id: 'config-deps',    label: 'Config, deps & CI',
    focus: 'dependency vulnerabilities/staleness, build/CI config, environment/secret configuration, and Capacitor/Android manifest settings.' },
];
function nextAuditType(lastId) {
  const i = AUDIT_TYPES.findIndex(t => t.id === lastId);
  return AUDIT_TYPES[(i + 1) % AUDIT_TYPES.length];
}

/* ── Google auth (service account JWT → access token) ── */
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

/* ── Firestore REST helpers (typed value <-> JS) ── */
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, toValue(val)])) } };
  return { stringValue: String(v) };
}
function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, fromValue(val)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  return null;
}
async function getDoc(token, docPath) {
  const res = await fetch(`${FIRESTORE_BASE}/${docPath}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get ${docPath} failed (${res.status}): ${await res.text()}`);
  const d = await res.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromValue(v)]));
}
async function patchDoc(token, docPath, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) };
  const res = await fetch(`${FIRESTORE_BASE}/${encodeURIComponent(docPath.split('/')[0])}/${encodeURIComponent(docPath.split('/').slice(1).join('/'))}?${mask}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch ${docPath} failed (${res.status}): ${await res.text()}`);
}
async function createDoc(token, collection, docId, fields) {
  const q = docId ? `?documentId=${encodeURIComponent(docId)}` : '';
  const res = await fetch(`${FIRESTORE_BASE}/${encodeURIComponent(collection)}${q}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!res.ok) throw new Error(`create in ${collection} failed (${res.status}): ${await res.text()}`);
}
async function setMaintenance(token, on, message) {
  const fields = { maintenanceMode: on };
  if (message) fields.maintenanceMessage = message;
  await patchDoc(token, 'app_config/singleton', fields);
}

/* ── Deterministic checks CI can genuinely run ── */
function runCheck(label, cmd) {
  try {
    const out = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    return { label, passed: true, output: out.slice(-4000) };
  } catch (e) {
    const out = ((e.stdout || '') + '\n' + (e.stderr || '')).slice(-4000);
    return { label, passed: false, output: out || String(e).slice(0, 4000) };
  }
}
function runDeterministicChecks() {
  return [
    runCheck('security-tests', 'node tests/frontend-security.test.mjs && node tests/backend-security.test.mjs'),
    runCheck('secret-scan', 'node scripts/check-no-secrets.js'),
    runCheck('secrets-placeholder', 'node scripts/check-secrets-placeholder.js'),
    runCheck('npm-audit-shipped', 'npm audit --omit=dev --audit-level=high'),
    runCheck('backend-npm-audit', 'cd backend && npm audit --audit-level=moderate'),
  ];
}

/* ── Gather source for the AI review (bounded) ── */
function readClipped(rel, maxChars) {
  try { const t = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); return t.length > maxChars ? t.slice(0, maxChars) + `\n…[truncated ${t.length - maxChars} chars]…` : t; }
  catch (e) { return `(could not read ${rel}: ${e.message})`; }
}
function gatherSource(auditType) {
  // Always include the rules + a slice of each client; for code-heavy audits,
  // include more. www/index.html is huge, so it is always clipped.
  const parts = [];
  parts.push(['backend/firestore.rules', readClipped('backend/firestore.rules', 12000)]);
  parts.push(['www/index.html (clipped)', readClipped('www/index.html', 90000)]);
  parts.push(['legal/admin/index.html (clipped)', readClipped('legal/admin/index.html', 45000)]);
  if (auditType === 'security' || auditType === 'code-quality' || auditType === 'data-integrity') {
    for (const f of ['backend/src/routes/orders.js', 'backend/src/routes/admin.js', 'backend/src/middleware/validate.js', 'backend/scripts/verify-order-prices.js']) {
      parts.push([f, readClipped(f, 12000)]);
    }
  }
  return parts.map(([name, body]) => `\n===== FILE: ${name} =====\n${body}`).join('\n');
}

/* ── Claude Opus review ── */
async function runAiReview(apiKey, area, checks) {
  const checkSummary = checks.map(c => `- ${c.label}: ${c.passed ? 'PASS' : 'FAIL'}${c.passed ? '' : '\n  ' + c.output.split('\n').slice(-6).join('\n  ')}`).join('\n');
  const system = `You are a senior application security engineer and code reviewer auditing "Modern Dairy", a Capacitor (vanilla-JS) Android ordering app for a dairy business in Pune, with an admin website and Firestore-rules backend (no server deployed yet). This is an automated nightly audit; tonight's focus area is "${area.label}": ${area.focus}

You are given the deterministic check results and a (clipped) slice of the source. Produce a precise, honest bug list for a human to review — real defects only, no filler, no style nitpicks unless they cause bugs. Prefer fewer high-confidence findings over many speculative ones. For anything you cannot verify from the clipped source, say so rather than guessing.

Respond with ONLY a JSON object (no markdown fence) of this exact shape:
{"summary":"one or two sentences on the app's health in this area tonight","findings":[{"title":"short title","severity":"critical|high|medium|low","area":"file or feature","problem":"what is wrong and why it matters","fix":"concrete suggested fix","confidence":"high|medium|low"}]}
If you find nothing material, return an empty findings array with a summary saying so.`;
  const user = `Deterministic check results:\n${checkSummary}\n\nSource under review:\n${gatherSource(area.id)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude API error (${res.status}): ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const jsonStr = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(jsonStr); }
  catch (e) { return { summary: 'AI review returned unparseable output; raw text stored.', findings: [], raw: text.slice(0, 4000) }; }
}

/* ── Main ── */
async function main() {
  const saRaw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!saRaw) throw new Error('FCM_SERVICE_ACCOUNT_JSON is not set.');
  const token = await getAccessToken(JSON.parse(saRaw));

  const schedule = (await getDoc(token, 'audit_control/schedule')) || {};
  if (!schedule.requested) { console.log('No audit armed for tonight — nothing to do.'); return; }

  const area = nextAuditType(schedule.lastAuditType);
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + area.id;
  console.log(`Audit armed. Focus tonight: ${area.label} (${area.id}). runId=${runId}`);

  const maintMsg = 'We are running our nightly checks to keep things running smoothly. The app will be back in a few minutes.';
  await setMaintenance(token, true, maintMsg);
  console.log('Maintenance mode ON.');

  let report;
  try {
    const checks = runDeterministicChecks();
    console.log('Deterministic checks:', checks.map(c => `${c.label}=${c.passed ? 'PASS' : 'FAIL'}`).join(', '));

    let ai = { summary: '', findings: [] };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try { ai = await runAiReview(apiKey, area, checks); console.log(`AI review: ${ai.findings.length} finding(s).`); }
      catch (e) { console.warn('AI review failed:', e.message); ai = { summary: 'AI review failed: ' + e.message, findings: [] }; }
    } else {
      ai = { summary: 'ANTHROPIC_API_KEY not set — deterministic checks only, no AI code review.', findings: [] };
    }

    // Turn failed deterministic checks into findings too.
    const checkFindings = checks.filter(c => !c.passed).map(c => ({
      title: `Automated check failed: ${c.label}`, severity: c.label.includes('secret') ? 'high' : 'medium',
      area: c.label, problem: c.output.split('\n').slice(-8).join(' ').slice(0, 800), fix: 'Investigate the failing check output.', confidence: 'high',
    }));
    const findings = [...checkFindings, ...(ai.findings || [])];

    report = {
      runId, area: area.id, areaLabel: area.label,
      summary: ai.summary || 'Audit complete.',
      checks: checks.map(c => ({ label: c.label, passed: c.passed })),
      findingsCount: findings.length,
      findings: findings.slice(0, 40),
      raw: ai.raw || '',
      at: new Date().toISOString(),
    };

    // Store the full audit report.
    await createDoc(token, 'audits', runId, {
      area: report.area, areaLabel: report.areaLabel, summary: report.summary,
      findingsCount: report.findingsCount,
      findings: report.findings.map(f => ({ title: String(f.title || '').slice(0, 300), severity: String(f.severity || 'low'),
        area: String(f.area || '').slice(0, 200), problem: String(f.problem || '').slice(0, 2000),
        fix: String(f.fix || '').slice(0, 2000), confidence: String(f.confidence || '') })),
      checks: report.checks, date: new Date().toISOString(), status: 'for-review',
    });

    // One maintenance-log summary entry so it surfaces in the admin tab.
    const sevCounts = report.findings.reduce((m, f) => { const s = f.severity || 'low'; m[s] = (m[s] || 0) + 1; return m; }, {});
    const sevLine = ['critical', 'high', 'medium', 'low'].filter(s => sevCounts[s]).map(s => `${sevCounts[s]} ${s}`).join(', ') || 'no issues';
    await createDoc(token, 'maintenance_log', '', {
      title: `Nightly audit — ${area.label}`, category: 'improvement', status: 'action-needed',
      area: area.label,
      problem: `${report.findingsCount} finding(s): ${sevLine}. ${report.summary}`.slice(0, 1800),
      fix: report.findingsCount ? 'See the Audits detail (audits/' + runId + '). Review and apply fixes as needed.' : 'No action needed this run.',
      verified: 'Automated checks: ' + report.checks.map(c => `${c.label} ${c.passed ? 'OK' : 'FAIL'}`).join(', '),
      date: new Date().toISOString(),
    });
    console.log(`Report written. ${report.findingsCount} finding(s).`);
  } finally {
    // ALWAYS take the app back out of maintenance and disarm, even if the
    // audit threw — never leave customers locked out.
    await setMaintenance(token, false, '');
    await patchDoc(token, 'audit_control/schedule', {
      requested: false, lastAuditType: area.id, lastAuditAt: new Date().toISOString(), lastRunId: runId,
    });
    console.log('Maintenance mode OFF. Schedule disarmed. Next focus rotates from', area.id + '.');
  }
}

main().catch(async (e) => {
  console.error('Audit run failed:', e);
  // Best-effort: never leave the app stuck in maintenance because of a crash.
  try {
    const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
    const token = await getAccessToken(sa);
    await setMaintenance(token, false, '');
    console.error('Recovered: maintenance mode forced OFF after failure.');
  } catch (_) { /* nothing more we can do */ }
  process.exit(1);
});
