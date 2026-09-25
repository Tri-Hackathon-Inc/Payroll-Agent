// Builds the chat messages sent to the model: the agent's configured instructions, guardrails,
// the payrun context (when the agent was invoked on a payrun), and the user's question.

function buildMessages({ agentName, config, question, context, history = [] }) {
  const system = [
    `You are "${agentName}", a payroll assistant. ${config.description || ''}`.trim(),
    `Instructions: ${config.instructions}`,
    'Answer only from the payroll data provided below. If the data does not contain the answer, say so.',
    'Be concise: lead with the answer, then list the specific employees, amounts, or lines that support it.',
    'Never change payroll; you can only explain and flag.',
  ].join('\n');
  const user = context
    ? `Payroll data:\n${context.text}\n\nQuestion: ${question}`
    : `No payroll data was provided with this question.\n\nQuestion: ${question}`;
  return [{ role: 'system', content: system },
    ...history.slice(-8).map(turn => ({ role: turn.role, content: turn.content.slice(0, 3000) })),
    { role: 'user', content: user }];
}

module.exports = { buildMessages };
