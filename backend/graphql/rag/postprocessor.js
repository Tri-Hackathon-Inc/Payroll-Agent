const { AnomalyPostprocessor } = require('../anomalyPostprocessor');

function parseAnswer(text, sources) {
  if (typeof text !== 'string' || text.length > 50000) throw new Error('Invalid answer.');
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'answer,findings,sourceIds'
    || typeof parsed.answer !== 'string' || !parsed.answer.trim() || parsed.answer.length > 3000
    || /[\u0000-\u0008\u000b-\u001f]/.test(parsed.answer)
    || !Array.isArray(parsed.sourceIds) || !Array.isArray(parsed.findings)) throw new Error('Invalid answer.');
  const allowed = new Set(sources.map(source => source.id));
  if ((sources.length && !parsed.sourceIds.length)
    || parsed.sourceIds.some(id => typeof id !== 'string' || !id.trim() || !allowed.has(id))) throw new Error('Invalid citations.');
  return { ...parsed, answer: parsed.answer.trim(), sourceIds: [...new Set(parsed.sourceIds)] };
}

function citedSources(sourceIds, sources) {
  const byId = new Map(sources.map(source => [source.id, source]));
  // Reference metadata comes from retrieved history, never from model prose.
  return sourceIds.map(id => {
    const { payrunId, employeeId, payDate, topic } = byId.get(id);
    return { id, payrunId, employeeId, payDate, topic };
  });
}

function formatAnswer(answer, calculatedReview) {
  const sections = [answer.summary];
  if (answer.sources.length) {
    const references = answer.sources.map((source, index) => {
      const label = [source.payrunId && `Payrun ${source.payrunId}`, source.employeeId && `Employee ${source.employeeId}`,
        source.payDate && `paid ${source.payDate}`, source.topic].filter(Boolean).join(' | ');
      return `${index + 1}. ${label || source.id}`;
    });
    sections.push(`Historical sources:\n${references.join('\n')}`);
  }
  sections.push(`Calculated review:\n${calculatedReview}`);
  return sections.join('\n\n');
}

// Raw provider output is consumed here, before either API adapter returns a chat response.
class PayrollAnswerPostprocessor {
  process(evidence, sources, output = {}) {
    let parsed = null;
    if (output.modelStatus === 'completed') {
      try {
        parsed = parseAnswer(output.text, sources);
        output = { ...output, text: JSON.stringify({ findings: parsed.findings }) };
      } catch {
        output = { modelStatus: 'invalid_response', reason: 'The model answer or its source references were invalid. Showing calculated evidence only.' };
      }
    }
    const result = new AnomalyPostprocessor().process(evidence, output);
    const accepted = parsed && result.analysis.modelStatus === 'completed';
    // Keep a structured, validated model answer available for callers that format their own chat UI.
    result.analysis.modelAnswer = accepted ? {
      summary: parsed.answer, sourceIds: parsed.sourceIds, sources: citedSources(parsed.sourceIds, sources),
      findings: result.analysis.findings.map(finding => ({ findingId: finding.id, ...finding.modelComment })),
    } : null;
    if (accepted) result.reply = formatAnswer(result.analysis.modelAnswer, result.reply);
    return { ...result, citedSourceIds: accepted ? parsed.sourceIds : [] };
  }
}

module.exports = { PayrollAnswerPostprocessor, parseAnswer };
