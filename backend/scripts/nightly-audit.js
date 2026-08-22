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
async function listCollection(token, name) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const url = `${FIRESTORE_BASE}/${encodeURIComponent(name)}?pageSize=100` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`list ${name} failed (${res.status})`);
    const data = await res.json();
    for (const d of (data.documents || [])) {
      const obj = { _id: d.name.split('/').pop() };
      for (const [k, v] of Object.entries(d.fields || {})) obj[k] = fromValue(v);
      out.push(obj);
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
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
async function runAiReview(apiKey, area, checks, prevAudit) {
  const checkSummary = checks.map(c => `- ${c.label}: ${c.passed ? 'PASS' : 'FAIL'}${c.passed ? '' : '\n  ' + c.output.split('\n').slice(-6).join('\n  ')}`).join('\n');
  // From the 2nd audit onward, carry the previous audit's findings forward so
  // this run VERIFIES whether each was actually resolved and re-reports the
  // ones that are still present.
  let prevBlock = '';
  if (prevAudit && Array.isArray(prevAudit.findings) && prevAudit.findings.length) {
    prevBlock = `\n\nPREVIOUS AUDIT (${prevAudit.areaLabel || prevAudit.area || 'n/a'}, ${prevAudit.date || ''}) reported these findings and suggested these fixes${prevAudit.prOpened ? ' (a draft PR was opened — it may or may not have been merged, so the fix may NOT be in the code yet)' : ''}:\n`
      + prevAudit.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} — ${f.area}\n   Problem: ${f.problem}\n   Suggested fix: ${f.fix}`).join('\n');
  }
  const system = `You are a senior application security engineer and code reviewer auditing "Modern Dairy", a Capacitor (vanilla-JS) Android ordering app for a dairy business in Pune, with an admin website and Firestore-rules backend (no server deployed yet). This is an automated nightly audit; tonight's focus area is "${area.label}": ${area.focus}

You are given the deterministic check results, a (clipped) slice of the current source, and — from the second audit onward — the PREVIOUS audit's findings.

Do TWO things:
1. REGRESSION CHECK: for each previous finding, determine from the CURRENT source whether it is now fixed or still present. Re-report any that are STILL present (mark carriedOver=true and keep/upgrade the fix suggestion). Do not re-report ones that are genuinely fixed.
2. NEW REVIEW: review tonight's focus area for additional real defects.

Produce a precise, honest bug list for a human to review — real defects only, no filler, no style nitpicks unless they cause bugs. Prefer fewer high-confidence findings over many speculative ones. For anything you cannot verify from the clipped source, say so rather than guessing.

Respond with ONLY a JSON object (no markdown fence) of this exact shape:
{"summary":"1-2 sentences incl. how many previous issues are now fixed vs still open","findings":[{"title":"short title","severity":"critical|high|medium|low","area":"file or feature","problem":"what is wrong and why it matters","fix":"concrete suggested fix","confidence":"high|medium|low","carriedOver":true|false}]}
If you find nothing material and all previous issues are fixed, return an empty findings array with a summary saying so.`;
  const user = `Deterministic check results:\n${checkSummary}${prevBlock}\n\nCurrent source under review:\n${gatherSource(area.id)}`;

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

/* ── Optional: draft a PR with proposed fixes ──────────────────────────────
 * Opt-in (audit_control/schedule.autoFixPR). Asks Opus for concrete, minimal
 * edits for the highest-confidence findings, applies them by EXACT string
 * replacement (an edit that doesn't match uniquely is skipped, never guessed),
 * re-runs the deterministic checks, and only opens a *draft* PR if they still
 * pass. If nothing applied or the checks regress, it reverts and opens no PR —
 * so a bad AI patch can never reach even a branch that looks green. A draft PR
 * changes nothing in the live app until a human reviews and merges it.
 */
function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
async function requestFixEdits(apiKey, area, findings) {
  const fixable = findings.filter(f => (f.confidence === 'high' || f.confidence === 'medium') && ['critical', 'high', 'medium'].includes(f.severity)).slice(0, 6);
  if (!fixable.length) return [];
  const system = `You are fixing bugs in the "Modern Dairy" repo. You are given specific findings and the current content of the relevant files. Produce MINIMAL, exact edits that fix them. Output ONLY JSON:
{"edits":[{"file":"repo/relative/path","description":"what this fixes","old_string":"exact snippet currently in the file (unique, enough context to be unambiguous)","new_string":"replacement"}]}
Rules: old_string must appear VERBATIM and EXACTLY ONCE in the given file content (include enough surrounding context). Keep each edit small and self-contained. Do not reformat unrelated code. If you cannot fix something safely with a precise edit, omit it. Prefer correctness and safety over completeness.`;
  const fileset = [...new Set(fixable.map(f => f.area).filter(a => a && fs.existsSync(path.join(REPO_ROOT, a))))].slice(0, 6);
  const fileBlocks = fileset.map(f => `\n===== FILE: ${f} =====\n${readClipped(f, 30000)}`).join('\n');
  const user = `Findings to fix:\n${fixable.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} (${f.area})\n   Problem: ${f.problem}\n   Suggested: ${f.fix}`).join('\n')}\n\nCurrent file contents:\n${fileBlocks || '(no matching files could be loaded — you may still propose edits to files you are confident about)'}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude fix call failed (${res.status})`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const jsonStr = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return (JSON.parse(jsonStr).edits) || []; } catch (e) { return []; }
}
function applyEdit(edit) {
  const abs = path.join(REPO_ROOT, edit.file);
  if (!abs.startsWith(REPO_ROOT) || !fs.existsSync(abs)) return false;   // no path escape, must exist
  const cur = fs.readFileSync(abs, 'utf8');
  if (typeof edit.old_string !== 'string' || !edit.old_string) return false;
  const first = cur.indexOf(edit.old_string);
  if (first === -1 || cur.indexOf(edit.old_string, first + 1) !== -1) return false;  // must match exactly once
  fs.writeFileSync(abs, cur.slice(0, first) + edit.new_string + cur.slice(first + edit.old_string.length), 'utf8');
  return true;
}
async function tryDraftFixPR(apiKey, area, runId, findings) {
  const applied = [];
  try {
    const edits = await requestFixEdits(apiKey, area, findings);
    if (!edits.length) return { opened: false, reason: 'no precise edits proposed' };
    for (const e of edits) { if (applyEdit(e)) applied.push(e); }
    if (!applied.length) return { opened: false, reason: 'no proposed edit applied cleanly' };

    // Gate: the same deterministic checks must still pass after the edits.
    const recheck = runDeterministicChecks();
    const failed = recheck.filter(c => !c.passed);
    if (failed.length) { sh('git checkout -- .'); return { opened: false, reason: 'proposed fixes regressed checks: ' + failed.map(f => f.label).join(', ') }; }

    // Commit to a new branch and open a DRAFT PR (never touches master).
    const branch = `nightly-audit/${runId}`;
    sh('git config user.email "audit-bot@users.noreply.github.com"');
    sh('git config user.name "Nightly Audit Bot"');
    sh(`git checkout -b ${branch}`);
    sh('git add -A');
    sh(`git commit -m ${JSON.stringify(`Nightly audit (${area.label}): proposed fixes [needs review]`)}`);
    sh(`git push -u origin ${branch}`);
    const body = `Automated draft from the nightly audit (focus: **${area.label}**, run \`${runId}\`).\n\n`
      + `**Unreviewed — do not merge without reading the diff.** ${applied.length} edit(s) applied by Claude Opus, kept only because the security/audit checks still passed afterward. They may still be wrong or incomplete.\n\n`
      + applied.map((e, i) => `${i + 1}. \`${e.file}\` — ${e.description || 'fix'}`).join('\n');
    const prUrl = sh(`gh pr create --draft --base master --head ${branch} --title ${JSON.stringify(`Nightly audit fixes: ${area.label}`)} --body ${JSON.stringify(body)}`, { env: { ...process.env } }).trim();
    return { opened: true, prUrl, count: applied.length };
  } catch (e) {
    try { sh('git checkout -- .'); } catch (_) {}
    return { opened: false, reason: 'error: ' + (e.message || e).slice(0, 300) };
  }
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

  // Load the most recent previous audit (2nd audit onward) so this run can
  // verify whether those bugs were actually fixed and re-report the open ones.
  let prevAudit = null;
  try {
    const prior = await listCollection(token, 'audits');
    prior.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    prevAudit = prior[0] || null;
    if (prevAudit) console.log(`Referring to previous audit: ${prevAudit._id} (${prevAudit.findingsCount || 0} findings).`);
    else console.log('No previous audit found — this is the first one.');
  } catch (e) { console.warn('Could not load previous audits:', e.message); }

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
      try { ai = await runAiReview(apiKey, area, checks, prevAudit); console.log(`AI review: ${ai.findings.length} finding(s).`); }
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

    // Optional: draft a PR with proposed fixes (opt-in, and only if we have a key + findings).
    let prResult = { opened: false, reason: 'not requested' };
    if (schedule.autoFixPR && apiKey && findings.length) {
      console.log('autoFixPR is on — attempting a draft PR with proposed fixes…');
      prResult = await tryDraftFixPR(apiKey, area, runId, findings);
      console.log('Draft PR:', prResult.opened ? `opened ${prResult.prUrl}` : `not opened (${prResult.reason})`);
    }

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
        fix: String(f.fix || '').slice(0, 2000), confidence: String(f.confidence || ''), carriedOver: !!f.carriedOver })),
      checks: report.checks, date: new Date().toISOString(), status: 'for-review',
      prOpened: !!prResult.opened, prUrl: prResult.opened ? prResult.prUrl : '', prNote: prResult.opened ? '' : prResult.reason,
    });

    // One maintenance-log summary entry so it surfaces in the admin tab.
    const sevCounts = report.findings.reduce((m, f) => { const s = f.severity || 'low'; m[s] = (m[s] || 0) + 1; return m; }, {});
    const sevLine = ['critical', 'high', 'medium', 'low'].filter(s => sevCounts[s]).map(s => `${sevCounts[s]} ${s}`).join(', ') || 'no issues';
    await createDoc(token, 'maintenance_log', '', {
      title: `Nightly audit — ${area.label}`, category: 'improvement', status: 'action-needed',
      area: area.label,
      problem: `${report.findingsCount} finding(s): ${sevLine}. ${report.summary}`.slice(0, 1800),
      fix: (prResult.opened ? `Draft PR with proposed fixes: ${prResult.prUrl} — review & merge if good. ` : '')
           + (report.findingsCount ? 'See the Audits detail (audits/' + runId + '). Review and apply fixes as needed.' : 'No action needed this run.'),
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
