function readWebhookReply(body) {
  if (typeof body === 'string') return body
  return body.reply || body.message || body.answer || 'Your request was sent to the agent webhook.'
}

// POST <BASE>webhook/<domain>/<agentId>. `context` tells the agent where it was invoked
// from in the host app, e.g. { page: 'payrun', payrunId, dataUrl }.
export async function callWebhook({ domain, agent, question, source = 'agent-studio-chat', context }) {
  const webhookUrl = `${import.meta.env.BASE_URL}webhook/${domain.name}/${agent.id}`
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source,
      domain: domain && { name: domain.name, label: domain.label },
      agent: { id: agent.id, name: agent.name },
      question,
      ...(context ? { context } : {}),
    }),
  })
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const body = isJson ? await response.json().catch(() => ({})) : await response.text()

  if (!response.ok) throw new Error(typeof body === 'object' ? body.message || `Webhook request failed (${response.status}).` : body || `Webhook request failed (${response.status}).`)
  return { id: `webhook-${Date.now()}`, reply: readWebhookReply(body) }
}
