import { useRef, useState } from 'react'
import { graphqlRequest } from './graphql/client'
import { CHAT_AGENT_MUTATION } from './graphql/operations'

export default function AgentChat({ agent, domain, onBack }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const pending = useRef(false)

  async function send(event) {
    event.preventDefault()
    if (pending.current || !input.trim()) return
    pending.current = true
    setSending(true)
    setError('')
    const message = input.trim()
    try {
      const { chatAgent } = await graphqlRequest(CHAT_AGENT_MUTATION, { input: {
        agentId: agent.id, domainName: domain.name, message,
        history: messages.slice(-40),
      } })
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
      <button className="btn btn-outline-secondary" disabled={sending} onClick={() => { setMessages([]); setError('') }}>New chat</button>
    </div>
    <p className="text-muted">{agent.modelConfig?.name || agent.config.model}</p>
    {agent.modelConfig?.provider === 'demo' && <p className="alert alert-info">Demo mode: replies echo your message. Select a configured model for generated answers.</p>}
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
    <p className="small text-muted mt-3 mb-0">Chat history lasts until you leave this page. Connected services and notifications are not executed from chat.</p>
  </div></div>
}
