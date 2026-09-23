/* The maintenance audit.
 *
 * Takes the facts healthFacts.js measured and asks Claude what a maintainer
 * should do about them, in the office's language rather than the system's.
 *
 * What this is NOT, and deliberately so: it does not read the source code, it
 * does not write code, and it cannot deploy anything. A button on a web
 * dashboard that can change production code is an admin session away from
 * being arbitrary code execution on the business, and no amount of convenience
 * is worth that trade. Code maintenance runs in CI instead, where it opens a
 * pull request a person merges — see .github/workflows/code-audit.yml.
 *
 * So this audits the RUNNING SYSTEM: the data, the flow, the things quietly
 * not working. That is most of what goes wrong with a deployed product anyway.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const repo = require('./repo');
const healthFacts = require('./healthFacts');
const { getSecret } = require('./secretManager');

const MODEL = 'claude-opus-5';

const SYSTEM = `You are the maintaining engineer for Modern Drivers, a driver-tracking
platform used by Modern Dairy in Pune, India. Around forty drivers carry an Android app
that records GPS while they are on a delivery round; an office dashboard turns that into
kilometre figures the company acts on.

You are given a health snapshot of the running system — counts and aggregates only, no
personal data. Audit it the way an engineer who owns this system would: find what is
broken, what is silently not working, and what will bite next month.

The one rule this product is built around, which should shape your judgement:
only provable Modern Dairy business kilometres count. Distance the system is not sure
about is reported as unknown, never folded into the business total. So a number that
looks bad because the system is being honest is NOT a fault — a high "unknown" share
with no order records is the system working correctly with insufficient evidence. Say
that plainly rather than reporting it as a defect.

Judge severity by consequence to the business, not by how unusual the number looks:

  critical  money or trust is wrong right now — the kilometre figures are
            unreliable, or data is being lost
  high      a feature the office paid for is not working
  medium    it works but is degrading, or will fail predictably
  low       worth tidying

Be specific and quantitative. "312 restaurants have no location, so they are invisible
to visit detection" beats "some data is missing". Every finding needs an action a
non-engineer in the office can actually take, or an explicit note that it needs a
developer.

Do not invent problems to look thorough. If something is genuinely fine, an empty
findings list is the correct answer and saying so is useful. Do not speculate about
code you cannot see.`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'One sentence a busy owner can read: is this system healthy or not, and why.',
    },
    overall: { type: 'string', enum: ['healthy', 'needs_attention', 'urgent'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string', description: 'Short, concrete, no jargon.' },
          whatIsWrong: { type: 'string', description: 'The fact, with the number behind it.' },
          whyItMatters: { type: 'string', description: 'The consequence to the business.' },
          whatToDo: { type: 'string', description: 'The specific next action.' },
          whoCanDoIt: { type: 'string', enum: ['office', 'developer'] },
        },
        required: ['severity', 'title', 'whatIsWrong', 'whyItMatters', 'whatToDo', 'whoCanDoIt'],
        additionalProperties: false,
      },
    },
    workingWell: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things genuinely in good shape. Honest, not padding.',
    },
  },
  required: ['headline', 'overall', 'findings', 'workingWell'],
  additionalProperties: false,
};

/* Run one audit. Returns the report and stores it, so the office can see
 * whether last month's findings were ever dealt with. */
async function runAudit({ adminId, now = Date.now() } = {}) {
  const apiKey = await getSecret('anthropic');
  if (!apiKey) {
    const err = new Error('No Anthropic API key is saved, so the audit cannot run.');
    err.code = 'NO_ANTHROPIC_KEY';
    throw err;
  }

  const facts = await healthFacts.gather({ now });
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    // Adaptive thinking: working out which of a dozen interacting numbers
    // actually matters is exactly the kind of judgement it helps with.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [{
      role: 'user',
      content: 'Health snapshot of the running system:\n\n' + JSON.stringify(facts, null, 2),
    }],
  });

  if (response.stop_reason === 'refusal') {
    const err = new Error('The audit was declined by the model.');
    err.code = 'REFUSED';
    throw err;
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let report;
  try {
    report = JSON.parse(text);
  } catch (e) {
    const err = new Error('The audit came back in a form this system could not read.');
    err.code = 'BAD_REPORT';
    throw err;
  }

  const record = {
    at: now,
    ranBy: adminId || null,
    model: MODEL,
    report,
    facts,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
  const ref = await repo.C.drivers().firestore.collection('maintenance_audits').add(record);
  await repo.writeAudit({
    adminId,
    action: 'maintenance.audit',
    target: ref.id,
    after: { overall: report.overall, findings: (report.findings || []).length },
  });

  return { id: ref.id, ...record };
}

async function listAudits({ limit = 12 } = {}) {
  const snap = await repo.C.drivers().firestore
    .collection('maintenance_audits')
    .orderBy('at', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = { MODEL, SYSTEM, SCHEMA, runAudit, listAudits };
