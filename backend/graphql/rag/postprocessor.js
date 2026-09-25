const { AnomalyPostprocessor } = require('../anomalyPostprocessor');

function parseAnswer(text, sources) {
  if (typeof text !== 'string' || text.length > 50000) throw new Error('Invalid answer.');
  const parsed = JSON.parse(text);
  if (!parsed || Object.keys(parsed).sort().join(',') !== 'answer,findings,sourceIds'
    || typeof parsed.answer !== 'string' || !parsed.answer.trim() || parsed.answer.length > 3000
    || /[\u0000-\u0008\u000b-\u001f]/.test(parsed.answer)
    || !Array.isArray(parsed.sourceIds) || !Array.isArray(parsed.findings)) throw new Error('Invalid answer.');
  const allowed = new Set(sources.map(source => source.id));
  if ((sources.length && !parsed.sourceIds.length) || parsed.sourceIds.some(id => !allowed.has(id))) throw new Error('Invalid citations.');
  return { ...parsed, answer: parsed.answer.trim(), sourceIds: [...new Set(parsed.sourceIds)] };
}

// Raw provider output is consumed here, before either API adapter returns a chat response.
class PayrollAnswerPostprocessor {
  process(evidence, sources, output) {
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
      summary: parsed.answer, sourceIds: parsed.sourceIds,
      findings: result.analysis.findings.map(finding => ({ findingId: finding.id, ...finding.modelComment })),
    } : null;
    if (accepted) result.reply = `${parsed.answer}\n\nCalculated review:\n${result.reply}`;
    return { ...result, citedSourceIds: accepted ? parsed.sourceIds : [] };
  }
}

module.exports = { PayrollAnswerPostprocessor, parseAnswer };
