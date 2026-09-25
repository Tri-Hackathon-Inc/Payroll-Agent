// Agent-to-agent handoff: an agent (e.g. Anomaly Detection) hands its conversation to an
// Incident Report agent, which collects evidence from the payroll API, adds headless-browser
// screenshots of each finding (evidence-capture service, when configured), writes an incident
// report (with its model when connected, otherwise from the evidence alone), and delivers it
// through the email notification tool.

const { loadPayrunContext } = require('./payrunContext');
const { callModel, unavailableReason } = require('./modelRuntime');

const MAX_CONVERSATION = 20;
const RECOMMENDATIONS = {
  'duplicate payment': 'Remove the duplicate pay line before approval.',
  'paid after termination': 'Stop this payment and confirm the termination date with HR.',
  'no tax withholding': 'Set up federal and state withholding (W-4) before approval.',
  'health deduction missing': 'Confirm the benefit enrollment and restore the deduction.',
  '401(k) deduction missing': 'Confirm the retirement election and restore the deduction.',
  'bonus outlier': 'Confirm the bonus was approved and the amount is correct.',
  'reimbursement outlier': 'Verify the expense receipts behind the reimbursement.',
  'overtime outlier': 'Confirm the overtime hours against approved timesheets.',
};
const CRITICAL = new Set(['duplicate payment', 'paid after termination', 'no tax withholding']);

const money = value => Math.round(value * 100) / 100;
const dollars = value => `$${money(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The handed-over conversation, trimmed to recent messages with plain text only.
function cleanConversation(conversation) {
  return (Array.isArray(conversation) ? conversation : []).slice(-MAX_CONVERSATION)
    .filter(item => item && typeof item.text === 'string')
    .map(item => ({ role: item.role === 'user' ? 'user' : 'agent', agent: item.agent || '', text: item.text.slice(0, 2000) }));
}

// Dollars that would be paid wrongly if the run were approved as is, where it can be computed.
function amountAtRisk(signal, lines, past) {
  const line = lines[0];
  const highest = pick => Math.max(0, ...past.map(pick));
  switch (signal.kind) {
    case 'duplicate payment': return line.gross * (lines.length - 1);
    case 'paid after termination': return line.gross;
    case 'bonus outlier': return line.earnings.bonus - highest(item => item.earnings.bonus);
    case 'reimbursement outlier': return line.earnings.reimbursement - highest(item => item.earnings.reimbursement);
    default: return null;
  }
}

// One evidence item per anomaly finding, limited to the employees the conversation discussed
// (all findings when it names none), each with a snapshot of the pay line and its history.
function collectEvidence(context, conversation, collectedAt) {
  const text = conversation.map(item => item.text).join('\n').toLowerCase();
  const findings = context.signals.filter(item => item.kind !== 'new hire');
  const discussed = findings.filter(item => text.includes(item.employeeId.toLowerCase()) || text.includes(item.name.toLowerCase()));
  return (discussed.length ? discussed : findings).map((signal, index) => {
    const lines = context.payrun.lines.filter(line => line.employeeId === signal.employeeId);
    const past = context.history.flatMap(run => run.lines.filter(line => line.employeeId === signal.employeeId)
      .map(line => ({ ...line, payrunId: run.id })));
    const line = lines[0];
    return {
      id: `EV-${index + 1}`,
      employeeId: signal.employeeId,
      name: signal.name,
      finding: signal.kind,
      detail: signal.detail,
      amountAtRisk: amountAtRisk(signal, lines, past),
      snapshot: {
        payLines: lines.length, gross: line.gross, net: line.net, hours: line.hours, earnings: line.earnings,
        taxes: line.taxes, deductions: line.deductions, employmentStatus: line.employmentStatus,
        hireDate: line.hireDate || null, terminationDate: line.terminationDate || null, paymentMethod: line.paymentMethod,
      },
      history: past.map(item => ({ payrunId: item.payrunId, gross: item.gross, overtimeHours: item.hours.overtime,
        bonus: item.earnings.bonus, reimbursement: item.earnings.reimbursement, health: item.deductions.health })),
      source: `Payroll API, payrun ${context.payrunId} and ${context.history.length} previous runs`,
      collectedAt,
    };
  });
}

function evidenceTable(evidence) {
  return ['| ID | Employee | Finding | Detail | Amount at risk |', '| --- | --- | --- | --- | --- |',
    ...evidence.map(item => `| ${item.id} | ${item.employeeId} ${item.name} | ${item.finding} | ${item.detail} | ${item.amountAtRisk == null ? '-' : dollars(item.amountAtRisk)} |`)].join('\n');
}

// Report written from the evidence alone (used when no model is connected).
function evidenceReport({ evidence, totalAtRisk, conversation }) {
  const employees = new Set(evidence.map(item => item.employeeId)).size;
  const actions = [...new Set(evidence.map(item => RECOMMENDATIONS[item.finding]).filter(Boolean))];
  return [
    '## Summary',
    `${evidence.length} finding${evidence.length === 1 ? '' : 's'} affecting ${employees} employee${employees === 1 ? '' : 's'}; ${dollars(totalAtRisk)} at risk if the run is approved as is.`,
    '',
    '## Recommended actions',
    ...actions.map(action => `- ${action}`),
    '',
    '## Handed-over conversation',
    ...(conversation.length ? conversation.map(item => `- ${item.role === 'user' ? 'User' : item.agent || 'Agent'}: ${item.text.replace(/\s+/g, ' ').slice(0, 300)}`) : ['- (none)']),
  ].join('\n');
}

function reportMessages({ config, fromAgent, conversation, evidence, totalAtRisk, context }) {
  const system = [
    'You are an incident report agent for payroll. Another agent handed you its conversation.',
    `Instructions: ${config.instructions}`,
    'Write Markdown with exactly these sections: "## Summary" (two sentences), "## Impact" (dollars at risk and who is affected),',
    '"## Recommended actions" (bullets, cite evidence IDs like EV-1). Use only the evidence and payroll data given. Do not repeat the evidence table.',
  ].join('\n');
  const user = [
    `Handed over by: ${fromAgent || 'another agent'}`,
    'Conversation:', ...conversation.map(item => `${item.role === 'user' ? 'User' : item.agent || 'Agent'}: ${item.text}`),
    '', `Evidence (total at risk ${dollars(totalAtRisk)}):`, evidenceTable(evidence),
    '', 'Payroll data:', context.text,
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Asks the evidence-capture service (headless browser) for read-only screenshots of each
// finding's pay rows and pay drawer. Screenshots are optional evidence: failures are reported,
// not fatal.
async function captureScreenshots({ domainName, payrunId, evidence }, { env = process.env, fetchImpl = fetch } = {}) {
  const base = (env.EVIDENCE_CAPTURE_URL || '').replace(/\/+$/, '');
  if (!base) return { error: 'EVIDENCE_CAPTURE_URL is not set, so no screenshots were taken.' };
  if (!evidence.length) return { captures: [] };
  try {
    const response = await fetchImpl(`${base}/capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domainName, payrunId, items: evidence.map(({ id, employeeId, name }) => ({ id, employeeId, name })) }),
      signal: AbortSignal.timeout(Number(env.CAPTURE_TIMEOUT_MS) || 90000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { error: body.message || `Evidence capture returned HTTP ${response.status}.` };
    return { captures: body.captures || [], capturedAt: body.capturedAt, source: body.source };
  } catch {
    return { error: 'Evidence capture service could not be reached.' };
  }
}

function screenshotSection(evidence) {
  const shots = evidence.flatMap(item => (item.screenshots || []).map(shot => ({ item, shot })));
  if (!shots.length) return [];
  return ['## Screenshots', ...shots.map(({ item, shot }) => `**${item.id} ${item.name}: ${shot.label}**\n\n![${item.id} ${shot.label}](${shot.dataUrl})\n`)];
}

// Sends the report through the email notification tool when its endpoint is configured.
async function deliverEmail({ subject, body }, { env = process.env, fetchImpl = fetch } = {}) {
  const to = env.INCIDENT_EMAIL_TO || 'payroll-team@example.com';
  const base = (env.EMAIL_API_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return { status: 'not-sent', to, reason: 'EMAIL_API_BASE_URL is not set, so the demo email tool has no endpoint.' };
  try {
    const response = await fetchImpl(`${base}/notifications/email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, body }), signal: AbortSignal.timeout(10000),
    });
    return response.ok ? { status: 'sent', to } : { status: 'failed', to, reason: `Email endpoint returned HTTP ${response.status}.` };
  } catch {
    return { status: 'failed', to, reason: 'Email endpoint could not be reached.' };
  }
}

async function createIncidentReport({ agent, config, model, invocation, domainName }, deps = {}) {
  const context = await (deps.loadContext || loadPayrunContext)(invocation, deps);
  if (!context) throw Object.assign(new Error('An incident report needs a payrun: open the agent from a payrun page.'), { status: 400 });
  const handoff = invocation.handoff || {};
  const conversation = cleanConversation(handoff.conversation);
  const now = (deps.now || (() => new Date()))();
  const createdAt = now.toISOString();
  const evidence = collectEvidence(context, conversation, createdAt);
  const capture = await captureScreenshots({ domainName, payrunId: context.payrunId, evidence }, deps);
  for (const item of evidence) {
    const result = (capture.captures || []).find(entry => entry.id === item.id);
    item.screenshots = result?.screenshots || [];
    if (result?.error) item.screenshotError = result.error;
  }
  const totalAtRisk = evidence.reduce((sum, item) => sum + (item.amountAtRisk || 0), 0);
  const severity = evidence.some(item => CRITICAL.has(item.finding)) ? 'critical' : evidence.length ? 'warning' : 'info';
  const id = `INC-${context.payrunId}-${now.getTime().toString(36).toUpperCase()}`;
  const title = `${evidence.length} payroll issue${evidence.length === 1 ? '' : 's'} in ${context.payrunId}`;

  let narrative = null, writtenBy = 'evidence', modelError = null, metrics = null;
  if (model && !unavailableReason(model, deps.env)) {
    try {
      const result = await callModel(model, reportMessages({ config, fromAgent: handoff.fromAgent, conversation, evidence, totalAtRisk, context }), deps);
      narrative = result.text; metrics = result.metrics; writtenBy = model.name;
    } catch (error) {
      modelError = error.message;
    }
  }
  const header = [`# ${id}: ${title}`, '',
    `- Severity: ${severity}`, `- Payrun: ${context.payrunId}`, `- Raised by: ${agent.name}, handed over from ${handoff.fromAgent || 'the payrun assistant'}`,
    `- Created: ${createdAt}`, `- Written by: ${writtenBy === 'evidence' ? 'evidence only (no model connected)' : writtenBy}`].join('\n');
  const report = [header, '', narrative || evidenceReport({ evidence, totalAtRisk, conversation }), '', '## Evidence', evidenceTable(evidence),
    '', ...screenshotSection(evidence)].join('\n');
  const email = await deliverEmail({ subject: `[${severity.toUpperCase()}] ${id}: ${title}`, body: report }, deps);

  return {
    reply: `Incident ${id} created: ${evidence.length} evidence item${evidence.length === 1 ? '' : 's'}, severity ${severity}, ${dollars(totalAtRisk)} at risk. `
      + (email.status === 'sent' ? `Emailed to ${email.to}.` : `Email not sent: ${email.reason}`),
    model: writtenBy === 'evidence' ? null : { id: model.id, name: model.name, modelId: model.modelId },
    metrics,
    incident: { id, title, severity, payrunId: context.payrunId, createdAt, fromAgent: handoff.fromAgent || null,
      evidence, totalAtRisk: money(totalAtRisk), report, writtenBy, modelError, email,
      screenshots: { taken: evidence.reduce((sum, item) => sum + item.screenshots.length, 0), capturedAt: capture.capturedAt || null, error: capture.error || null } },
  };
}

module.exports = { createIncidentReport, collectEvidence, deliverEmail };
