import { useEffect, useRef, useState } from 'react'
import { agentStudioRequest, askAgent, conversationKey, resetAgentConversation } from './api'
import { SERVICE_AGENT_REGISTRY_QUERY } from './operations'
import { QUESTION_LIBRARY } from './questionLibrary'
import IncidentCard from './IncidentCard'

const INCIDENT_TEMPLATE = 'incident-report'

const AGENT_STUDIO_URL = import.meta.env.VITE_AGENT_STUDIO_URL || 'http://localhost:5173/ai_studio/'

// Payrun questions offered after the agent's own starting questions, so the panel always has a
// few suggestions (agents created before these existed saved only one question).
const PAYRUN_QUESTIONS = [
  'Which payments need review?',
  'How does this payrun compare to the previous one?',
  'What is the total net pay for this payrun?',
  'Who worked overtime this payrun?',
  'Is anyone paid after their termination date?',
  'What should I check before approving this payrun?',
]
const SUGGESTION_COUNT = 4

// The embedded agent: lists the domain's Agent Studio agents attached to the "payrun" page
// and sends questions to Agent Studio's webhook with the open payrun as context. It stays
// mounted while hidden, so the conversation survives closing and reopening the panel.
export default function AssistantPanel({ domain, run, employeeId, onEmployeeChange, open, onClose }) {
  const [allAgents, setAllAgents] = useState(null)
  const [handingOff, setHandingOff] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [agentId, setAgentId] = useState('')
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [librarySearch, setLibrarySearch] = useState('')

  // Reload on open: agents may have been created in Agent Studio meanwhile.
  useEffect(() => {
    if (!open) return undefined
    let active = true
    setLoadError('')
    agentStudioRequest(SERVICE_AGENT_REGISTRY_QUERY, { domainName: domain.name })
      .then((data) => { if (active) setAllAgents(data.getServiceAgentRegistry.filter((agent) => agent.config?.page === 'payrun')) })
      .catch((requestError) => { if (active) setLoadError(requestError.message) })
    return () => { active = false }
  }, [domain.name, open])

  // Chat agents answer questions; an Incident Report agent is reached only through a handoff.
  const agents = allAgents?.filter((item) => item.templateId !== INCIDENT_TEMPLATE) || null
  const incidentAgent = allAgents?.find((item) => item.templateId === INCIDENT_TEMPLATE)
  const agent = agents?.find((item) => item.id === agentId) || agents?.[0]
  const isAnomalyAgent = agent?.templateId === 'anomaly-detection'
  const employees = [...new Map(run.lines.map((line) => [line.employeeId, line])).values()]
  const employee = employees.find((item) => item.employeeId === employeeId)
  const context = { page: 'payrun', payrunId: run.id, employeeId: employeeId || null }
  const scope = agent ? conversationKey({ domain, agent, context }) : ''
  const visibleMessages = messages.filter((item) => item.scope === scope)
  const busy = sending || handingOff

  // Agent-to-agent: hand this conversation to the Incident Report agent, which collects
  // evidence, writes the report, and emails it.
  async function handOff() {
    if (!agent || !incidentAgent || busy) return
    setError('')
    setHandingOff(true)
    const conversation = visibleMessages.filter((item) => item.role === 'user' || item.role === 'agent')
      .map((item) => ({ role: item.role, agent: item.agent, text: item.text }))
    setMessages((current) => [...current, { id: `handoff-${Date.now()}`, role: 'handoff', text: `${agent.name} handed this conversation to ${incidentAgent.name}.`, scope }])
    try {
      const response = await askAgent({
        domain, agent: incidentAgent, question: 'Create an incident report from this conversation.',
        context: { ...context, task: 'incident-report', handoff: { fromAgent: agent.name, conversation } },
      })
      setMessages((current) => [...current, { id: response.id, role: 'incident', agent: incidentAgent.name, text: response.reply, incident: response.incident, scope }])
    } catch (requestError) {
      setError(requestError.message || 'The incident agent could not be reached.')
    } finally {
      setHandingOff(false)
    }
  }
  const lastAgentMessage = [...visibleMessages].reverse().find((item) => item.role === 'agent' || item.role === 'incident')

  async function ask(text) {
    const trimmed = text.trim()
    if (!trimmed || !agent || busy) return
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
        modelStatus: response.analysis?.modelStatus, sources: response.retrieval?.sources, scope, source: response.source,
        // Suggestions and already-raised incidents are shown only under review answers.
        suggested: response.incidentAlert?.review ? response.incidentAlert.suggested || [] : [],
        alreadyRaised: response.incidentAlert?.review && !response.incidentAlert.raised ? response.incidentAlert.alreadyRaised || 0 : 0,
        alertNote: response.incidentAlert?.note || '' },
      // Critical findings are raised as an incident automatically (severity policy on the backend).
      ...(response.incidentAlert?.raised ? [
        { id: `${response.id}-auto`, role: 'handoff', scope, text: `${response.incidentAlert.raised.findings.length} critical finding${response.incidentAlert.raised.findings.length === 1 ? '' : 's'}: ${agent.name} raised an incident automatically with ${response.incidentAlert.raised.agent.name}.` },
        { id: `${response.id}-incident`, role: 'incident', scope, agent: response.incidentAlert.raised.agent.name, text: response.incidentAlert.raised.reply, incident: response.incidentAlert.raised.incident },
      ] : [])])
    } catch (requestError) {
      setError(requestError.message || 'The agent could not be reached.')
      setQuestion(trimmed)
    } finally {
      setSending(false)
    }
  }

  // Up to four suggestions, dropping questions already asked so new ones rotate in.
  const asked = new Set(visibleMessages.filter((item) => item.role === 'user').map((item) => item.text))
  const suggestions = [...new Set([...(agent?.config.questions || []), ...PAYRUN_QUESTIONS])]
    .filter((item) => !asked.has(item)).slice(0, SUGGESTION_COUNT)

  const query = librarySearch.trim().toLowerCase()
  const library = QUESTION_LIBRARY.map((group) => ({ ...group, prompts: group.prompts.filter((item) => !query || item.toLowerCase().includes(query)) }))
    .filter((group) => group.prompts.length)
  const closeLibrary = () => { setLibraryOpen(false); setLibrarySearch('') }
  const askFromLibrary = (item) => { closeLibrary(); ask(item) }

  // The question list closes on a click outside it (its own toggle chip excluded) or on Esc,
  // which closes only the list, not the whole assistant.
  const libraryRef = useRef(null)
  const browseRef = useRef(null)
  useEffect(() => {
    if (!libraryOpen) return undefined
    const onMouseDown = (event) => {
      if (libraryRef.current?.contains(event.target) || browseRef.current?.contains(event.target)) return
      closeLibrary()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [libraryOpen])

  const thread = useRef(null)
  useEffect(() => { thread.current?.scrollTo?.({ top: thread.current.scrollHeight }) }, [messages, sending, scope, open])

  return <aside id="tn-assistant" className="tn-copilot" aria-label="Payroll assistant" hidden={!open}>
    <header className="tn-copilot-head">
      <span className="tn-copilot-mark" aria-hidden="true"><i className="bi bi-stars" /></span>
      <div className="flex-grow-1 min-w-0">
        <h2 className="tn-copilot-title">Payroll Assistant</h2>
        <div className="tn-copilot-context text-truncate">{run.id} · {domain.label}</div>
      </div>
      <button type="button" className="tn-icon-btn" onClick={onClose} aria-label="Close assistant"><i className="bi bi-x-lg" /></button>
    </header>

    {loadError ? <p className="tn-copilot-note text-danger">Could not load agents from Agent Studio: {loadError}</p>
      : !agents ? <p className="tn-copilot-note"><span className="spinner-border spinner-border-sm me-2" />Loading agents…</p>
      : !agents.length ? <p className="tn-copilot-note">No agents are attached to the payrun page yet. Create one from the Anomaly Detection or Summarizer template in <a href={`${AGENT_STUDIO_URL}?domain=${encodeURIComponent(domain.name)}`} target="_blank" rel="noreferrer">Agent Studio</a>, then reopen this panel.</p>
      : <>
        <div className="tn-copilot-agent">
          <label className="visually-hidden" htmlFor="tn-agent">Agent</label>
          <i className="bi bi-robot" aria-hidden="true" />
          <select id="tn-agent" className="form-select form-select-sm" disabled={busy} value={agent.id} onChange={(event) => { setAgentId(event.target.value); setError('') }}>
            {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div className="px-3 pb-2">
          <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
            <label className="form-label small fw-semibold mb-0" htmlFor="tn-employee">Employee scope</label>
            <button type="button" className="btn btn-outline-secondary btn-sm" disabled={busy} onClick={() => {
              resetAgentConversation({ domain, agent, context })
              setMessages((current) => current.filter((item) => item.scope !== scope))
              setError('')
            }}>New chat</button>
          </div>
          <select id="tn-employee" className="form-select form-select-sm mb-2" disabled={busy} value={employeeId} onChange={(event) => { onEmployeeChange(event.target.value); setError('') }}>
            <option value="">All employees</option>
            {employees.map((item) => <option key={item.employeeId} value={item.employeeId}>{item.name} ({item.employeeId})</option>)}
          </select>
          <p className="small text-muted mb-0" role="status">{employee
            ? `Reviewing ${employee.name} (${employee.employeeId}) only.`
            : 'Reviewing all employees in this payrun. Select an employee for an individual review.'}
            {isAnomalyAgent && ' Payments are compared with earlier completed payruns.'}</p>
        </div>
        <div ref={thread} className="tn-copilot-thread" aria-live="polite">
          {!visibleMessages.length && <div className="tn-copilot-empty">
            <span className="tn-copilot-mark large" aria-hidden="true"><i className="bi bi-stars" /></span>
            <p className="fw-semibold mb-1">Ask about this payrun</p>
            <p className="small text-muted mb-0">{agent.name} reads {run.id} and its recent history. Pick a suggestion below or type your own question.</p>
          </div>}
          {visibleMessages.map((item) => item.role === 'handoff'
            ? <div key={item.id} className="tn-copilot-handoff"><i className="bi bi-arrow-left-right" aria-hidden="true" />{item.text}</div>
            : item.role === 'incident' && item.incident
              ? <IncidentCard key={item.id} agentName={item.agent} incident={item.incident} />
              : <div key={item.id} className={`tn-copilot-message ${item.role}`}>
                {item.agent && <div className="tn-copilot-author"><i className="bi bi-stars me-1" aria-hidden="true" />{item.agent}</div>}
                {item.modelStatus && <div className="small text-muted mb-1">
                  {item.modelStatus === 'completed' ? 'Calculated evidence with model explanations' : 'Calculated evidence only'}
                </div>}
                <div className="tn-copilot-bubble">{item.text}</div>
                {item.sources?.length > 0 && <details className="small mt-2"><summary>Historical sources ({item.sources.length})</summary>
                  <ul>{item.sources.map((source) => <li key={source.id}>{source.employeeId} · {source.payrunId} · {source.topic}{source.cited ? ' (cited)' : ''}</li>)}</ul>
                </details>}
                {item.source && <div className={`tn-copilot-source ${item.source.kind}`}>
                  <i className={`bi ${item.source.kind === 'data' ? 'bi-calculator' : 'bi-cpu'} me-1`} aria-hidden="true" />{item.source.label}
                  {item.source.checked === true && <span title="Every employee and dollar amount matches the payroll data"> · figures checked</span>}
                </div>}
                {item.alertNote && <div className="tn-copilot-alert"><i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />{item.alertNote}</div>}
                {item.alreadyRaised > 0 && <div className="tn-copilot-alert info">
                  <i className="bi bi-check2-circle me-1" aria-hidden="true" />{item.alreadyRaised} critical finding{item.alreadyRaised === 1 ? ' was' : 's were'} already raised as an incident for this payrun.
                </div>}
                {item.suggested?.length > 0 && <div className="tn-copilot-alert warning">
                  <i className="bi bi-flag me-1" aria-hidden="true" />Suggested for an incident ({item.suggested.length} warning{item.suggested.length === 1 ? '' : 's'}): {item.suggested.map((finding) => `${finding.name} (${finding.kind})`).join(', ')}
                </div>}
                {item === lastAgentMessage && item.role === 'agent' && <div className="tn-copilot-actions">
                  {incidentAgent
                    ? <button type="button" className="tn-copilot-action" disabled={handingOff || sending} onClick={handOff}>
                      <i className="bi bi-file-earmark-medical" aria-hidden="true" />Create incident report with {incidentAgent.name}
                    </button>
                    : <span className="small text-muted">To file an incident, create an Incident Report agent in <a href={`${AGENT_STUDIO_URL}?domain=${encodeURIComponent(domain.name)}`} target="_blank" rel="noreferrer">Agent Studio</a>.</span>}
                </div>}
              </div>)}
          {handingOff && <div className="tn-copilot-message agent"><div className="tn-copilot-bubble text-muted"><span className="spinner-border spinner-border-sm me-2" />{incidentAgent.name} is collecting evidence and writing the report…</div></div>}
          {sending && <div className="tn-copilot-message agent"><div className="tn-copilot-bubble text-muted"><span className="spinner-border spinner-border-sm me-2" />Analyzing {run.id}…</div></div>}
        </div>
        {error && <p className="tn-copilot-error" role="alert"><i className="bi bi-exclamation-circle me-1" />{error}</p>}
      </>}

    {agent && <form className="tn-copilot-compose" onSubmit={(event) => { event.preventDefault(); ask(question) }}>
      {libraryOpen && <div ref={libraryRef} className="tn-copilot-library" role="dialog" aria-label="All questions"
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeLibrary() } }}>
        <div className="tn-copilot-library-head">
          <input type="search" value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)}
            placeholder="Search questions…" aria-label="Search questions" autoFocus />
          <button type="button" className="tn-icon-btn" onClick={closeLibrary} aria-label="Close question list"><i className="bi bi-x-lg" /></button>
        </div>
        <div className="tn-copilot-library-body">
          {library.map((group) => <section key={group.category} aria-label={group.category}>
            <h3>{group.category}</h3>
            {group.prompts.map((item) => <button type="button" key={item} disabled={busy} onClick={() => askFromLibrary(item)}>{item}</button>)}
          </section>)}
          {!library.length && <p className="text-muted small m-0">No questions match. You can still type your own below.</p>}
        </div>
      </div>}
      <div className="tn-copilot-suggestions" role="group" aria-label="Suggested questions">
        {suggestions.map((item) => <button type="button" key={item} className="tn-copilot-chip" disabled={busy} onClick={() => ask(item)}>
          <i className="bi bi-stars" aria-hidden="true" />{item}
        </button>)}
        <button ref={browseRef} type="button" className="tn-copilot-chip tn-copilot-browse" aria-expanded={libraryOpen}
          onClick={() => (libraryOpen ? closeLibrary() : setLibraryOpen(true))}>
          <i className="bi bi-list-ul" aria-hidden="true" />All questions ({QUESTION_LIBRARY.reduce((total, group) => total + group.prompts.length, 0)})
        </button>
      </div>
      <div className="tn-copilot-input">
        <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={`Ask ${agent.name}…`} aria-label={`Ask ${agent.name}`} />
        <button type="submit" disabled={!question.trim() || busy} aria-label="Send"><i className="bi bi-send" /></button>
      </div>
      <p className="tn-copilot-disclaimer">AI-generated answers can be wrong. Verify before approving payroll.</p>
    </form>}
  </aside>
}
