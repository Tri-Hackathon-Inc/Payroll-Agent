import { useRef, useState } from 'react'
import { graphqlRequest } from './graphql/client'
import { CHAT_AGENT_MUTATION } from './graphql/operations'

// crypto.randomUUID exists only on HTTPS and localhost; getRandomValues works on plain HTTP too
// (e.g. a cloud-dev hostname), and its hex output fits the backend's request ID format.
const newRequestId = () => globalThis.crypto?.randomUUID?.()
  ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')


export default function AgentChat({ agent, domain, onBack }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [payrunId, setPayrunId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const pending = useRef(false)
  const sessionKey = `studio-chat:${JSON.stringify([domain.name, agent.id, payrunId.trim(), employeeId.trim()])}`

  function newChat() {
    try { sessionStorage.removeItem(sessionKey) } catch { /* Browser storage may be disabled. */ }
    setMessages([])
    setError('')
  }

  async function send(event) {
    event.preventDefault()
    if (pending.current || !input.trim()) return
    pending.current = true
    setSending(true)
    setError('')
    const message = input.trim()
    try {
      let sessionId
      try { sessionId = sessionStorage.getItem(sessionKey) || undefined } catch { /* Use a new session. */ }
      const { chatAgent } = await graphqlRequest(CHAT_AGENT_MUTATION, { input: {
        agentId: agent.id, domainName: domain.name, message,
        history: sessionId ? [] : messages.slice(-40), sessionId, requestId: newRequestId(),
        context: payrunId.trim() ? { page: 'payrun', payrunId: payrunId.trim(), employeeId: employeeId.trim() || null } : {},
      } })
      if (chatAgent.session?.id) {
        try { sessionStorage.setItem(sessionKey, chatAgent.session.id) } catch { /* The answer remains available. */ }
      }
      setMessages(current => [...current,
        { role: 'user', content: message },
        { role: 'assistant', content: chatAgent.output },
      ])
      setInput('')
    } catch (failure) {
      setError(failure.message)
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  return <div className="card border-0 shadow-sm"><div className="card-body p-4">
    <button className="btn btn-link px-0" onClick={onBack}>Back to my agents</button>
    <div className="d-flex justify-content-between align-items-center gap-3">
      <h1 className="h4">Chat with {agent.name}</h1>
      <button className="btn btn-outline-secondary" disabled={sending} onClick={newChat}>New chat</button>
    </div>
    <p className="text-muted">{agent.modelConfig?.name || agent.config.model}</p>
    {agent.modelConfig?.provider === 'demo' && <p className="alert alert-info">Demo mode: replies echo your message. Select a configured model for generated answers.</p>}
    <details className="mb-3"><summary>Payroll context for historical comparisons</summary>
      <div className="row g-2 mt-1">
        <div className="col-sm-6"><label htmlFor="chat-payrun" className="form-label">Payrun ID (optional)</label>
          <input id="chat-payrun" className="form-control" placeholder="PR-2026-09-B" disabled={sending} value={payrunId}
            onChange={event => { setPayrunId(event.target.value); setMessages([]); setError('') }} /></div>
        <div className="col-sm-6"><label htmlFor="chat-employee" className="form-label">Employee ID (optional)</label>
          <input id="chat-employee" className="form-control" placeholder="All employees" disabled={sending || !payrunId.trim()} value={employeeId}
            onChange={event => { setEmployeeId(event.target.value); setMessages([]); setError('') }} /></div>
      </div>
    </details>
    <div role="log" aria-label="Conversation" aria-live="polite" className="my-4">
      {!messages.length && <p className="text-muted">Send a message to start a conversation.</p>}
      {messages.map((message, index) => <div key={index} className="border rounded p-3 mb-3">
        <strong>{message.role === 'user' ? 'You' : agent.name}</strong>
        <p className="mb-0 mt-2" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.content}</p>
      </div>)}
    </div>
    {error && <div role="alert" className="alert alert-danger">{error}</div>}
    {sending && <p role="status">Waiting for a response…</p>}
    <form onSubmit={send}>
      <label className="form-label" htmlFor="chat-message">Message</label>
      <textarea id="chat-message" className="form-control mb-3" rows={3} maxLength={10000} required disabled={sending}
        value={input} onChange={event => setInput(event.target.value)} />
      <button className="btn btn-dark" disabled={sending || !input.trim()} type="submit">{sending ? 'Sending…' : 'Send message'}</button>
    </form>
    <p className="small text-muted mt-3 mb-0">Conversation context is kept temporarily for follow-ups. New chat starts a fresh session. Add a payrun to retrieve employee payment history.</p>
  </div></div>
}
