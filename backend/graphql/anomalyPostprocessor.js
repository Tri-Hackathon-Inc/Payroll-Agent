function validateComments(text, findings) {
  if (typeof text !== 'string' || text.length > 50000) throw new Error('Invalid model output.');
  const parsed = JSON.parse(text);
  if (!parsed || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.findings)
    || parsed.findings.length !== findings.length) throw new Error('Incomplete findings.');
  const expected = new Set(findings.map(finding => finding.id));
  const comments = new Map();
  for (const comment of parsed.findings) {
    if (!comment || Object.keys(comment).sort().join(',') !== 'explanation,findingId,reviewAction'
      || !expected.has(comment.findingId) || comments.has(comment.findingId)
      || !['explanation', 'reviewAction'].every(key => typeof comment[key] === 'string'
        && comment[key].trim().length > 0 && comment[key].length <= 600 && !/[\u0000-\u0008\u000b-\u001f]/.test(comment[key]))) {
      throw new Error('Unexpected finding or comment.');
    }
    comments.set(comment.findingId, { explanation: comment.explanation.trim(), reviewAction: comment.reviewAction.trim() });
  }
  return comments;
}

function evidenceText(finding) {
  const e = finding.evidence;
  if (e.metric) {
    const change = e.percentChange === null ? 'percentage unavailable because the baseline is zero' : `${e.percentChange > 0 ? '+' : ''}${e.percentChange}%`;
    return `${e.current} ${e.unit}; historical median ${e.baseline} ${e.unit}; change ${e.delta > 0 ? '+' : ''}${e.delta} (${change}), based on ${e.historyCount} completed payment(s).`;
  }
  if (e.lineCount) return `${e.lineCount} lines in this payrun. These may be legitimate split payments.`;
  if (e.terminationDate) return `Termination ${e.terminationDate}; gross ${e.current} ${e.unit}. Confirm any authorized final-pay adjustment.`;
  return `${e.current} ${e.unit}.`;
}

class AnomalyPostprocessor {
  process(evidence, { text, modelStatus = 'not_configured', reason = null } = {}) {
    let comments = new Map();
    if (modelStatus === 'completed') {
      try { comments = validateComments(text, evidence.findings); }
      catch {
        modelStatus = 'invalid_response';
        reason = 'The model response did not match the calculated findings. Showing calculated evidence only.';
      }
    }
    const findings = evidence.findings.map(finding => ({ ...finding, modelComment: comments.get(finding.id) || null }));
    const analysis = { ...evidence, findings, modelStatus, modelMessage: reason };
    const lines = [`Payrun ${evidence.payrunId}: ${findings.length} review finding(s) across ${evidence.employees.length} employee(s).`, evidence.method];
    for (const employee of evidence.employees) {
      lines.push(`\n${employee.name} (${employee.employeeId}) — ${employee.historyCount} comparable completed payrun(s).`);
      if (employee.historyStatus === 'insufficient') lines.push('Insufficient history: historical payment changes could not be assessed.');
      if (employee.historyStatus === 'limited') lines.push('Limited history: treat the comparison as preliminary.');
      if (employee.missingFields.length) lines.push(`Missing or invalid fields were not compared: ${employee.missingFields.join(', ')}.`);
      const employeeFindings = findings.filter(finding => finding.employeeId === employee.employeeId);
      if (!employeeFindings.length && employee.historyCount) lines.push('No configured thresholds were exceeded in the available data.');
      for (const finding of employeeFindings) {
        lines.push(`- ${finding.label}: ${evidenceText(finding)}`);
        if (finding.modelComment) lines.push(`  Model explanation: ${finding.modelComment.explanation}\n  Suggested review: ${finding.modelComment.reviewAction}`);
      }
    }
    if (reason) lines.push(`\nModel: ${reason}`);
    lines.push('\nThese are review indicators. Payroll has not been changed.');
    return { analysis, reply: lines.join('\n') };
  }
}

module.exports = { AnomalyPostprocessor };
