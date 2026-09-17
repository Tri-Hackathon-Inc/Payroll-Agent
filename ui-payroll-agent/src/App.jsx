import { useEffect, useState } from 'react'
import './App.css'

const domains = ['HR', 'Payroll', 'Time off']

function SparkleIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c.45 5.38 3.12 8.05 8.5 8.5-5.38.45-8.05 3.12-8.5 8.5-.45-5.38-3.12-8.05-8.5-8.5 5.38-.45 8.05-3.12 8.5-8.5Z" /></svg>
}

function App() {
  const [form, setForm] = useState({ name: '', domain: '', description: '', prompt: '' })
  const [questions, setQuestions] = useState([''])
  const [status, setStatus] = useState(() => window.location.pathname === '/agents/new' ? 'form' : 'list')
  const [agents, setAgents] = useState([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState(null)

  useEffect(() => {
    fetch('/api/agents/')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load agents.')
        return response.json()
      })
      .then((data) => setAgents(data))
      .catch((requestError) => setError(`${requestError.message} Make sure Django is running on port 8000.`))
      .finally(() => setDataLoaded(true))
  }, [])

  useEffect(() => {
    const loadRoute = () => {
      if (!dataLoaded) return
      const path = window.location.pathname
      const match = path.match(/^\/agents\/([^/]+)$/)

      if (path === '/agents/new') {
        setEditingId(null)
        setForm({ name: '', domain: '', description: '', prompt: '' })
        setQuestions([''])
        setStatus('form')
      } else if (match && match[1] !== 'new') {
        const agent = agents.find(({ id }) => String(id) === decodeURIComponent(match[1]))
        if (agent) {
          setForm({ name: agent.name, domain: agent.domain, description: agent.description, prompt: agent.instructions || '' })
          setQuestions(agent.questions?.length ? agent.questions : [''])
          setEditingId(agent.id)
          setStatus('form')
        } else {
          window.history.replaceState({}, '', '/agents')
          setStatus('list')
        }
      } else {
        if (path !== '/agents') window.history.replaceState({}, '', '/agents')
        setStatus('list')
      }
    }

    loadRoute()
    window.addEventListener('popstate', loadRoute)
    return () => window.removeEventListener('popstate', loadRoute)
  }, [agents, dataLoaded])

  const goTo = (path) => {
    window.history.pushState({}, '', path)
  }

  const updateField = ({ target: { name, value } }) => {
    setForm((current) => ({ ...current, [name]: value }))
  }
  const updateQuestion = (index, value) => {
    setQuestions((current) => current.map((question, i) => (i === index ? value : question)))
  }

  const createAgent = async (event) => {
    event.preventDefault()
    setError('')
    setStatus('loading')

    try {
      const response = await fetch('/api/agents/save/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          name: form.name,
          domain: form.domain,
          description: form.description,
          instructions: form.prompt,
          questions: questions.filter((question) => question.trim()),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to save the agent.')

      setAgents((current) => editingId
        ? current.map((agent) => agent.id === editingId ? data : agent)
        : [data, ...current])
      window.history.pushState({}, '', '/agents')
      setStatus('list')
    } catch (requestError) {
      setError(`${requestError.message} Make sure Django is running on port 8000.`)
      setStatus('form')
    }
  }

  const startNewAgent = () => {
    setForm({ name: '', domain: '', description: '', prompt: '' })
    setQuestions([''])
    setEditingId(null)
    goTo('/agents/new')
    setStatus('form')
  }

  const openAgent = (agent) => {
    setForm({
      name: agent.name,
      domain: agent.domain,
      description: agent.description,
      prompt: agent.instructions || '',
    })
    setQuestions(agent.questions?.length ? agent.questions : [''])
    setEditingId(agent.id)
    goTo(`/agents/${encodeURIComponent(agent.id)}`)
    setStatus('form')
  }

  const cancelForm = () => {
    if (editingId) {
      goTo('/agents')
      setStatus('list')
    } else if (window.history.length > 1) {
      window.history.back()
    } else {
      goTo('/agents')
      setStatus('list')
    }
  }

  if (status === 'loading') {
    return (
      <main className="loading-page" aria-live="polite" aria-busy="true">
        <div className="loader"><SparkleIcon /></div>
        <h2>{editingId ? 'Updating your agent' : 'Creating your agent'}</h2>
        <p>{editingId ? 'Saving the latest agent details…' : 'Preparing its instructions and starting questions…'}</p>
      </main>
    )
  }

  if (!dataLoaded && status !== 'form') {
    return (
      <main className="loading-page" aria-live="polite" aria-busy="true">
        <div className="loader"><SparkleIcon /></div>
        <h2>Loading agents</h2>
        <p>Fetching the available agents…</p>
      </main>
    )
  }

  if (status === 'list') {
    return (
      <main className="agents-page">
        <header className="agents-header">
          <div>
            <div className="eyebrow"><SparkleIcon /> Agent builder</div>
            <h1>Available agents</h1>
            <p>Choose an agent to get help, or create one for a new workflow.</p>
          </div>
          <button className="primary-button new-agent-button" type="button" onClick={startNewAgent}>+ Create agent</button>
        </header>
        {error && <p className="error-banner" role="alert">{error}</p>}
        <section className="agent-grid" aria-label="Available agents">
          {agents.map((agent, index) => (
            <article className={`agent-card ${index === 0 ? 'new-card' : ''}`} key={agent.id}>
              <div className="agent-card-top">
                <div className="agent-icon"><SparkleIcon /></div>
                <span className={`domain-badge domain-${agent.domain.toLowerCase().replace(' ', '-')}`}>{agent.domain}</span>
              </div>
              <h2>{agent.name}</h2>
              <p>{agent.description}</p>
              <button type="button" className="open-agent" onClick={() => openAgent(agent)}>Open agent <span>→</span></button>
            </article>
          ))}
        </section>
      </main>
    )
  }

  return (
    <main className="page-shell">
      <section className="form-panel" aria-labelledby="page-title">
        <header className="page-header">
          <div className="eyebrow"><SparkleIcon /> Agent builder</div>
          <h1 id="page-title">{editingId ? 'Edit agent' : 'Create a new agent'}</h1>
          <p>{editingId ? 'Update this agent’s details, instructions, and starting questions.' : 'Give your agent the context and guidance it needs to help your team.'}</p>
        </header>

        <form onSubmit={createAgent}>
          {error && <p className="error-banner" role="alert">{error}</p>}
          <div className="form-grid">
            <label className="field">
              <span>Agent name <b>*</b></span>
              <input name="name" value={form.name} onChange={updateField} placeholder="e.g. Payroll Assistant" required />
            </label>
            <label className="field">
              <span>Domain <b>*</b></span>
              <div className="select-wrap">
                <select name="domain" value={form.domain} onChange={updateField} required>
                  <option value="" disabled>Select a domain</option>
                  {domains.map((domain) => <option key={domain}>{domain}</option>)}
                </select>
              </div>
            </label>
          </div>

          <label className="field">
            <span>Description <b>*</b></span>
            <textarea name="description" value={form.description} onChange={updateField} placeholder="What does this agent help with?" rows="3" maxLength="240" required />
            <small>{form.description.length}/240</small>
          </label>

          <label className="field">
            <span>Instructions <b>*</b></span>
            <textarea name="prompt" value={form.prompt} onChange={updateField} placeholder="Describe how the agent should respond, what it should know, and any rules it should follow." rows="7" required />
            <em>Be specific about the agent’s role, tone, and boundaries.</em>
          </label>

          <fieldset>
            <legend>Starting questions <span>Optional</span></legend>
            <p className="legend-help">Help people get started with a few example questions.</p>
            <div className="question-list">
              {questions.map((question, index) => (
                <div className="question-row" key={index}>
                  <span className="question-number">{index + 1}</span>
                  <input value={question} onChange={(event) => updateQuestion(index, event.target.value)} placeholder="e.g. When is the next payroll date?" aria-label={`Starting question ${index + 1}`} />
                  {questions.length > 1 && <button className="icon-button" type="button" onClick={() => setQuestions((current) => current.filter((_, i) => i !== index))} aria-label={`Remove question ${index + 1}`}>×</button>}
                </div>
              ))}
            </div>
            <button className="add-button" type="button" onClick={() => setQuestions((current) => [...current, ''])}>+ Add another question</button>
          </fieldset>

          <footer className="form-footer">
            <button className="secondary-button" type="button" onClick={cancelForm}>Cancel</button>
            <button className="primary-button" type="submit">{editingId ? 'Save changes' : 'Create agent'} <span>→</span></button>
          </footer>
        </form>
      </section>

      <aside className="accent-panel" aria-hidden="true">
        <div className="orb orb-one" /><div className="orb orb-two" />
        <div className="preview-card">
          <div className="preview-mark"><SparkleIcon /></div>
          <span>Your agent</span>
          <strong>{form.name || 'Payroll Assistant'}</strong>
          <p>{form.description || 'A helpful expert, ready to support your team.'}</p>
          <div className="preview-domain">{form.domain || 'Domain'}</div>
        </div>
      </aside>
    </main>
  )
}

export default App
