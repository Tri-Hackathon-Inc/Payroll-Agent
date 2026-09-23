import { useEffect, useMemo, useRef, useState } from 'react'
import { graphqlRequest } from './graphql/client'
import { BUSINESSES_QUERY, BUSINESS_AGENTS_QUERY } from './graphql/operations'

const AVATAR_TONES = ['blue', 'violet', 'orange', 'green']

function toChatAgents(agents = []) {
  return agents.map((agent, index) => ({
    id: agent.id,
    name: agent.name,
    description: agent.config?.description || 'Custom payroll agent',
    initials: agent.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase(),
    tone: AVATAR_TONES[index % AVATAR_TONES.length],
    questions: agent.config?.questions || [],
  }))
}

function readWebhookReply(body) {
  if (typeof body === 'string') return body
  return body.reply || body.message || body.answer || 'Your request was sent to the agent webhook.'
}

async function callWebhook({ business, agent, question }) {
  const webhookUrl=location.origin+"/"+business.name+"/"+agent.name
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'agent-studio-chat',
      business: business && { name: business.name, label: business.label },
      agent: { id: agent.id, name: agent.name },
      question,
    }),
  })
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const body = isJson ? await response.json().catch(() => ({})) : await response.text()

  if (!response.ok) throw new Error(typeof body === 'object' ? body.message || `Webhook request failed (${response.status}).` : body || `Webhook request failed (${response.status}).`)
  return { id: `webhook-${Date.now()}`, reply: readWebhookReply(body) }
}

function AgentAvatar({ agent, large = false }) {
  return <span className={`agent-avatar avatar-${agent.tone}${large ? ' large' : ''}`}>{agent.initials}</span>
}

function EmptyConversation({ hasBusiness, hasAgents }) {
  const noAgents = hasBusiness && !hasAgents
  return <div className="chat-empty-state">
    <div className="empty-orbit"><i className={`bi ${noAgents ? 'bi-robot' : 'bi-chat-square-text'}`} /></div>
    <h2>{noAgents ? 'No agents are available yet' : 'Start a conversation'}</h2>
    <p>{noAgents ? 'Create an agent in Agent Studio and configure its questions to make it available here.' : <>Type <kbd>@</kbd> to pick an agent, then choose one of its suggested questions or write your own.</>}</p>
  </div>
}

function ConversationMessage({ item }) {
  return <div className={`chat-message ${item.role}`}>
    {item.role === 'agent' && <AgentAvatar agent={item.agent} />}
    <div>
      {item.role === 'agent' && <div className="message-author">{item.agent.name}</div>}
      <div className="message-bubble">{item.text}</div>
    </div>
  </div>
}

export default function ChatWindow({ businessName }) {
  const [businesses, setBusinesses] = useState([])
  const [business, setBusiness] = useState(() => businessName ? { name: businessName, label: businessName } : null)
  const [rawAgents, setRawAgents] = useState([])
  const [loadedBusinessName, setLoadedBusinessName] = useState('')
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [messages, setMessages] = useState([])
  const [message, setMessage] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerStage, setPickerStage] = useState('businesses')
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const inputRef = useRef(null)
  const pickerRef = useRef(null)
  const agents = useMemo(() => toChatAgents(rawAgents), [rawAgents])

  useEffect(() => {
    const closePicker = event => {
      if (pickerRef.current && !pickerRef.current.contains(event.target) && event.target !== inputRef.current) setPickerOpen(false)
    }
    document.addEventListener('mousedown', closePicker)
    return () => document.removeEventListener('mousedown', closePicker)
  }, [])

  async function loadBusinessAgents(nextBusiness) {
    setBusiness(nextBusiness)
    setPickerStage('agents')
    setPickerError('')
    setPickerLoading(true)
    try {
      const data = await graphqlRequest(BUSINESS_AGENTS_QUERY, { businessName: nextBusiness.name })
      setRawAgents(data.getBusinessAgents)
      setLoadedBusinessName(nextBusiness.name)
    } catch (error) {
      setRawAgents([])
      setPickerError(error.message)
    } finally {
      setPickerLoading(false)
    }
  }

  async function openPicker() {
    setPickerOpen(true)
    setPickerError('')
    if (business) {
      setPickerStage('agents')
      if (loadedBusinessName !== business.name) await loadBusinessAgents(business)
      return
    }
    setPickerStage('businesses')
    if (businesses.length) return
    setPickerLoading(true)
    try {
      const data = await graphqlRequest(BUSINESSES_QUERY)
      setBusinesses(data.listBusinesses)
    } catch (error) {
      setPickerError(error.message)
    } finally {
      setPickerLoading(false)
    }
  }

  function selectAgent(agent) {
    setSelectedAgent(agent)
    setPickerOpen(false)
    setMessage(current => current.replace(/@$/, ''))
    inputRef.current?.focus()
  }

  function handleMessageChange(event) {
    const nextMessage = event.target.value
    setMessage(nextMessage)
    if (nextMessage.endsWith('@')) openPicker()
  }

  async function sendMessage(event) {
    event.preventDefault()
    const question = message.trim()
    if (!question || !selectedAgent || sending) return
    setSendError('')
    setMessages(current => [...current, { id: `user-${Date.now()}`, role: 'user', text: question, agent: selectedAgent }])
    setMessage('')
    setSending(true)
    try {
      const response = await callWebhook({ business, agent: selectedAgent, question })
      setMessages(current => [...current, { id: response.id, role: 'agent', text: response.reply, agent: selectedAgent }])
    } catch (error) {
      setSendError(error.message || 'The webhook could not be reached.')
      setMessage(question)
    } finally {
      setSending(false)
    }
  }

  const showBusinessPicker = pickerStage === 'businesses'
  const pickerTitle = showBusinessPicker ? 'Choose a business' : `Choose an agent${business ? ` · ${business.label}` : ''}`
  const pickerLabel = showBusinessPicker ? 'Available businesses' : 'Available agents'
  const itemCount = showBusinessPicker ? businesses.length : agents.length

  return <section className="chat-workspace">
    <header className="chat-header">
      <div><p className="eyebrow mb-2">{business?.label || 'Select a business'} · Connected workspace</p><h1>Talk to your agents</h1><p className="chat-subtitle mb-0">Choose a specialist, ask a question, and route it to your connected tools.</p></div>
    </header>
    <div className="chat-panel">
      <div className="chat-thread" aria-live="polite">
        {!messages.length ? <EmptyConversation hasBusiness={Boolean(business)} hasAgents={Boolean(agents.length)} /> : messages.map(item => <ConversationMessage item={item} key={item.id} />)}
        {sending && <div className="chat-message agent"><AgentAvatar agent={selectedAgent} /><div><div className="message-author">{selectedAgent.name}</div><div className="message-bubble typing-indicator"><span /><span /><span /></div></div></div>}
      </div>
      <div className="chat-composer-wrap">
        {selectedAgent && <div className="selected-agent-bar"><div className="d-flex align-items-center gap-2"><AgentAvatar agent={selectedAgent} /><span><strong>{selectedAgent.name}</strong></span></div><button type="button" className="agent-clear" onClick={() => setSelectedAgent(null)} aria-label={`Remove ${selectedAgent.name}`}><i className="bi bi-x-lg" /></button></div>}
        {selectedAgent?.questions.length > 0 && <div className="question-pills" aria-label={`${selectedAgent.name} suggested questions`}>{selectedAgent.questions.map(question => <button type="button" className="question-pill" key={question} onClick={() => setMessage(question)}>{question}</button>)}</div>}
        <form className="chat-composer" onSubmit={sendMessage}>
          <div className="composer-main">{selectedAgent && <span className="composer-mention">@{selectedAgent.name.replace(/\s+/g, '')}</span>}<input ref={inputRef} value={message} onChange={handleMessageChange} placeholder={selectedAgent ? `Message ${selectedAgent.name}…` : 'Type @ to choose a business and agent…'} aria-label="Message an agent" /><button type="submit" className="send-button" disabled={!message.trim() || !selectedAgent || sending} aria-label="Send message"><i className="bi bi-arrow-up" /></button></div>
          <div className="composer-hint"><span><kbd>@</kbd> choose an agent</span><span>Enter to send</span></div>
        </form>
        {sendError && <p className="webhook-error" role="alert"><i className="bi bi-exclamation-circle" /> {sendError}</p>}
        {pickerOpen && <div ref={pickerRef} className="agent-picker" role="listbox" aria-label={pickerLabel}>
          <div className="picker-title"><span>{pickerTitle}</span><span>{pickerLoading ? 'Loading…' : `${itemCount} available`}</span></div>
          {!showBusinessPicker && <button type="button" className="picker-back" onClick={() => setPickerStage('businesses')}><i className="bi bi-arrow-left" /> Change business</button>}
          {pickerError ? <p className="picker-error">Could not load options: {pickerError}</p> : pickerLoading ? <p className="picker-loading"><span className="spinner-border spinner-border-sm me-2" />Loading…</p> : <div className="agent-picker-grid">
            {showBusinessPicker ? businesses.map(item => <button type="button" role="option" className="agent-option" key={item.name} onClick={() => loadBusinessAgents(item)}><span className="business-picker-icon"><i className="bi bi-building" /></span><span><strong>{item.label}</strong><small>{item.domain}</small></span><i className="bi bi-arrow-right" /></button>) : agents.map(agent => <button type="button" role="option" aria-selected={selectedAgent?.id === agent.id} className="agent-option" key={agent.id} onClick={() => selectAgent(agent)}><AgentAvatar agent={agent} large /><span><strong>{agent.name}</strong><small>{agent.description}</small></span><i className="bi bi-arrow-up-right" /></button>)}
            {!showBusinessPicker && !agents.length && <p className="picker-empty">This business has no configured agents yet.</p>}
          </div>}
        </div>}
      </div>
    </div>
  </section>
}
