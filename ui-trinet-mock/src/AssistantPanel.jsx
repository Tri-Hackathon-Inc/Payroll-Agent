import { useEffect, useState } from 'react'
import { agentStudioRequest, askAgent } from './api'
import { SERVICE_AGENT_REGISTRY_QUERY } from './operations'

const AGENT_STUDIO_URL = import.meta.env.VITE_AGENT_STUDIO_URL || 'http://localhost:5173/ai_studio/'

// The embedded agent: lists the domain's Agent Studio agents attached to the "payrun" page
// and sends questions to Agent Studio's webhook with the open payrun as context.
export default function AssistantPanel({ domain, run, onClose }) {
  const [agents, setAgents] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [agentId, setAgentId] = useState('')
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  // Reload on open: agents may have been created in Agent Studio meanwhile.
  useEffect(() => {
    let active = true
    agentStudioRequest(SERVICE_AGENT_REGISTRY_QUERY, { domainName: domain.name })
      .then((data) => { if (active) setAgents(data.getServiceAgentRegistry.filter((agent) => agent.config?.page === 'payrun')) })
      .catch((requestError) => { if (active) setLoadError(requestError.message) })
    return () => { active = false }
  }, [domain.name])

  const agent = agents?.find((item) => item.id === agentId) || agents?.[0]

  async function ask(text) {
    const trimmed = text.trim()
    if (!trimmed || !agent || sending) return
    setError('')
    setSending(true)
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', text: trimmed }])
    setQuestion('')
    try {
      const response = await askAgent({
        domain, agent, question: trimmed,
        context: { page: 'payrun', payrunId: run.id, payrunStatus: run.status, payDate: run.payDate },
      })
      setMessages((current) => [...current, { id: response.id, role: 'agent', text: response.reply, agent: agent.name }])
    } catch (requestError) {
      setError(requestError.message || 'The agent could not be reached.')
      setQuestion(trimmed)
    } finally {
      setSending(false)
    }
  }

  return <aside className="tn-drawer tn-assistant" aria-label="Payroll assistant">
    <div className="tn-drawer-head">
      <h2><i className="bi bi-stars me-2" />Payroll Assistant</h2>
      <button type="button" className="tn-icon-btn" onClick={onClose} aria-label="Close"><i className="bi bi-x-lg" /></button>
    </div>
    <div className="tn-drawer-body d-flex flex-column">
      <p className="text-muted small">Agents from <strong>{domain.label}</strong> attached to the payrun page. They receive {run.id} as context.</p>
      {loadError ? <p className="text-danger small">Could not load agents from Agent Studio: {loadError}</p>
        : !agents ? <p className="text-muted small"><span className="spinner-border spinner-border-sm me-2" />Loading agents…</p>
        : !agents.length ? <p className="text-muted small">No agents are attached to the payrun page yet. Create one from the Anomaly Detection or Summarizer template in <a href={`${AGENT_STUDIO_URL}?domain=${encodeURIComponent(domain.name)}`} target="_blank" rel="noreferrer">Agent Studio</a>, then reopen this panel.</p>
        : <>
          <label className="form-label small fw-semibold" htmlFor="tn-agent">Agent</label>
          <select id="tn-agent" className="form-select form-select-sm mb-3" value={agent.id} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {agent.config.questions?.length > 0 && <div className="d-flex flex-wrap gap-2 mb-3">
            {agent.config.questions.map((item) => <button type="button" key={item} className="tn-pill" disabled={sending} onClick={() => ask(item)}>{item}</button>)}
          </div>}
          <div className="tn-thread flex-grow-1 mb-3" aria-live="polite">
            {messages.map((item) => <div key={item.id} className={`tn-message ${item.role}`}>
              {item.agent && <div className="small fw-semibold mb-1">{item.agent}</div>}
              {item.text}
            </div>)}
            {sending && <p className="text-muted small mb-0"><span className="spinner-border spinner-border-sm me-2" />Waiting for {agent.name}…</p>}
          </div>
          {error && <p className="text-danger small mb-2" role="alert"><i className="bi bi-exclamation-circle me-1" />{error}</p>}
        </>}
    </div>
    {agent && <form className="tn-drawer-foot" onSubmit={(event) => { event.preventDefault(); ask(question) }}>
      <input className="form-control" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question or type a command…" aria-label={`Ask ${agent.name}`} />
      <button type="submit" className="tn-btn-primary" disabled={!question.trim() || sending} aria-label="Send"><i className="bi bi-arrow-up" /></button>
    </form>}
  </aside>
}
