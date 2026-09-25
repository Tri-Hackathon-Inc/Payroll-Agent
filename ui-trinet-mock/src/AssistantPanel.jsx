import { useEffect, useState } from 'react'
import { agentStudioRequest, askAgent, conversationKey, resetAgentConversation } from './api'
import { SERVICE_AGENT_REGISTRY_QUERY } from './operations'

const AGENT_STUDIO_URL = import.meta.env.VITE_AGENT_STUDIO_URL || 'http://localhost:5173/ai_studio/'

// The embedded agent: lists the domain's Agent Studio agents attached to the "payrun" page
// and sends questions to Agent Studio's webhook with the open payrun as context.
export default function AssistantPanel({ domain, run, employeeId, onEmployeeChange, onClose }) {
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
  const isAnomalyAgent = agent?.templateId === 'anomaly-detection'
  const employees = [...new Map(run.lines.map((line) => [line.employeeId, line])).values()]
  const employee = employees.find((item) => item.employeeId === employeeId)
  const context = { page: 'payrun', payrunId: run.id, employeeId: employeeId || null }
  const scope = agent ? conversationKey({ domain, agent, context }) : ''

  async function ask(text) {
    const trimmed = text.trim()
    if (!trimmed || !agent || sending) return
    setError('')
    setSending(true)
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', text: trimmed, scope }])
    setQuestion('')
    try {
      const response = await askAgent({
        domain, agent, question: trimmed,
        context,
      })
      setMessages((current) => [...current, { id: response.id, role: 'agent', text: response.reply, agent: agent.name,
        modelStatus: response.analysis?.modelStatus, sources: response.retrieval?.sources, scope }])
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
          <select id="tn-agent" className="form-select form-select-sm mb-3" disabled={sending} value={agent.id} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <div className="d-flex align-items-center justify-content-between gap-2 mb-3">
            <span className="small text-muted">Follow-up questions use this conversation&apos;s context.</span>
            <button type="button" className="btn btn-outline-secondary btn-sm text-nowrap" disabled={sending} onClick={() => {
              resetAgentConversation({ domain, agent, context })
              setMessages((current) => current.filter((item) => item.scope !== scope))
              setError('')
            }}>New chat</button>
          </div>
          <label className="form-label small fw-semibold" htmlFor="tn-employee">Employee scope</label>
          <select id="tn-employee" className="form-select form-select-sm mb-2" disabled={sending} value={employeeId} onChange={(event) => { onEmployeeChange(event.target.value); setError('') }}>
            <option value="">All employees</option>
            {employees.map((employee) => <option key={employee.employeeId} value={employee.employeeId}>{employee.name} ({employee.employeeId})</option>)}
          </select>
          <p className="small text-muted" role="status">{employee
            ? `Reviewing ${employee.name} (${employee.employeeId}) only.`
            : 'Reviewing all employees in this payrun. Select an employee for an individual review.'}
            {isAnomalyAgent && ' Payments are compared with earlier completed payruns.'}</p>
          {agent.config.questions?.length > 0 && <div className="d-flex flex-wrap gap-2 mb-3">
            {agent.config.questions.map((item) => <button type="button" key={item} className="tn-pill" disabled={sending} onClick={() => ask(item)}>{item}</button>)}
          </div>}
          <div className="tn-thread flex-grow-1 mb-3" aria-live="polite">
            {messages.filter((item) => item.scope === scope).map((item) => <div key={item.id} className={`tn-message ${item.role}`}>
              {item.agent && <div className="small fw-semibold mb-1">{item.agent}</div>}
              {item.modelStatus && <div className="small text-muted mb-1">
                {item.modelStatus === 'completed' ? 'Calculated evidence with model explanations' : 'Calculated evidence only'}
              </div>}
              <div className="tn-message-text">{item.text}</div>
              {item.sources?.length > 0 && <details className="small mt-2"><summary>Historical sources ({item.sources.length})</summary>
                <ul>{item.sources.map((source) => <li key={source.id}>{source.employeeId} · {source.payrunId} · {source.topic}{source.cited ? ' (cited)' : ''}</li>)}</ul>
              </details>}
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
