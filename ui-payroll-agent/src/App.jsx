import { useEffect, useState } from 'react'
import './App.css'

const domains = ['HR', 'Payroll', 'Time off']

const TEMPLATES = [
  {
    id: 'anomaly-detection',
    name: 'Anomaly Detection Agent',
    domain: 'Payroll',
    agentType: 'Anomaly detection',
    accent: 'orange',
    icon: 'bi-activity',
    runtime: 'REAL-TIME',
    runtimeDetail: 'Real-time / long-running',
    capabilities: ['Streaming / event input', 'History + rules utilities', 'Detect · score · alert'],
    tools: 'History · Rules · Alert API',
    description: 'Watches payrun changes in real time and flags amounts that look off versus history.',
    instructions: "On every payrun change, compare the new amount against the employee's historical payruns. Flag any change greater than the configured threshold (default 2000) and summarize what changed and why it looks unusual.",
    questions: ['Why did this payrun amount change?', 'Show me the flagged changes for this payrun.'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'summarizer',
    name: 'Summarizer Agent',
    domain: 'Payroll',
    agentType: 'Summarizer',
    accent: 'green',
    icon: 'bi-file-earmark-text',
    runtime: 'OFFLINE',
    runtimeDetail: 'Offline / scheduled',
    capabilities: ['On-demand / scheduled', 'Context retrieval utilities', 'Summarize · structure'],
    tools: 'Payrun Data · Employee Records',
    description: 'Summarizes a payrun or employee record so admins get the key numbers at a glance.',
    instructions: 'Fetch the employee and payrun details for the selected record and produce a short summary covering rate changes, hours, earnings, and taxes. Keep it to a few bullet points.',
    questions: ['Summarize this payrun.', "Summarize this employee's earnings and taxes."],
    model: 'llama-3.1-70b',
  },
  {
    id: 'general-query',
    name: 'General Query Agent',
    domain: 'Payroll',
    agentType: 'General query',
    accent: 'blue',
    icon: 'bi-chat-dots',
    runtime: 'INTERACTIVE',
    runtimeDetail: 'Interactive / on-demand',
    capabilities: ['Question + context', 'Tool-calling pattern', 'Reason · answer'],
    tools: 'FAQ KB · Payrun Lookup',
    description: 'Answers everyday payroll questions like pay dates, rates, and hours.',
    instructions: 'Answer employee and admin questions about payroll using the current payrun data. Be concise, cite the specific payrun or employee record you used, and say when you are not sure.',
    questions: ['When is the next payroll date?', 'What is the overall payrun amount this cycle?'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'custom',
    name: 'Custom Agent',
    domain: 'Payroll',
    agentType: 'Custom',
    accent: 'purple',
    icon: 'bi-sliders',
    runtime: 'CONFIGURABLE',
    runtimeDetail: 'Fully configurable',
    capabilities: ['Blank instructions', 'Your own tools', 'Full control'],
    tools: 'Bring your own',
    description: 'Start from a blank agent and write your own instructions.',
    instructions: '',
    questions: [''],
    model: 'qwen-2.5-72b',
  },
]

const MODEL_OPTIONS = [
  { id: 'qwen-2.5-72b', label: 'Qwen 2.5 · 72B (open source)' },
  { id: 'llama-3.1-70b', label: 'Llama 3.1 · 70B (open source)' },
  { id: 'mistral-large', label: 'Mistral Large' },
  { id: 'bedrock-claude', label: 'AWS Bedrock · Claude' },
]

const NAV_ITEMS = [
  { key: 'templates', label: 'Templates', icon: 'bi-grid-1x2', path: '/ai-studio' },
  { key: 'my-agents', label: 'My Agents', icon: 'bi-robot', path: '/agents' },
  { key: 'tools', label: 'Tools & APIs', icon: 'bi-plug', soon: true },
  { key: 'models', label: 'Models', icon: 'bi-cpu', soon: true },
  { key: 'registry', label: 'Agent Registry', icon: 'bi-collection', anchor: 'agent-registry' },
  { key: 'evaluation', label: 'Evaluation', icon: 'bi-graph-up', soon: true },
]

function domainClass(domain) {
  return `domain-badge domain-${domain.toLowerCase().replace(' ', '-')}`
}

function Sidebar({ activeKey, onNavigate }) {
  return (
    <aside className="app-sidebar d-flex flex-column flex-shrink-0 p-3">
      <div className="d-flex align-items-center gap-2 px-1 mb-4">
        <span className="sidebar-mark"><i className="bi bi-stars" /></span>
        <span className="text-white fw-bold text-uppercase sidebar-brand">Agent Studio</span>
      </div>
      <ul className="nav nav-pills flex-column gap-1">
        {NAV_ITEMS.map((item) => (
          <li className="nav-item" key={item.key}>
            <button
              type="button"
              className={`nav-link sidebar-link d-flex align-items-center gap-2 w-100 text-start${activeKey === item.key ? ' active' : ''}`}
              onClick={() => onNavigate(item)}
            >
              <i className={`bi ${item.icon}`} />
              <span className="flex-grow-1">{item.label}</span>
              {item.soon && <span className="badge rounded-pill sidebar-soon">Soon</span>}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function TopBar({ section, page }) {
  return (
    <div className="d-flex align-items-center justify-content-between bg-white border-bottom px-4 py-3">
      <nav aria-label="breadcrumb">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item text-muted">{section}</li>
          <li className="breadcrumb-item active fw-semibold" aria-current="page">{page}</li>
        </ol>
      </nav>
      <span className="badge rounded-pill topbar-pill">Payroll domain</span>
    </div>
  )
}

function AppShell({ activeKey, onNavigate, notice, onDismissNotice, breadcrumb, children }) {
  return (
    <div className="app-shell d-flex">
      <Sidebar activeKey={activeKey} onNavigate={onNavigate} />
      <div className="flex-grow-1 d-flex flex-column min-vw-0">
        <TopBar section={breadcrumb[0]} page={breadcrumb[1]} />
        <main className="flex-grow-1 p-4 p-xl-5">
          {notice && (
            <div className="alert alert-success d-flex align-items-center justify-content-between py-2 px-3 mb-4" role="alert">
              <span className="small">{notice}</span>
              <button type="button" className="btn-close" onClick={onDismissNotice} aria-label="Dismiss" />
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  )
}

function AgentFields({ form, updateField, questions, updateQuestion, setQuestions }) {
  return (
    <>
      <div className="row g-3 mb-3">
        <div className="col-md-6">
          <label className="form-label fw-semibold">Agent name <span className="text-danger">*</span></label>
          <input className="form-control" name="name" value={form.name} onChange={updateField} placeholder="e.g. Payroll Assistant" required />
        </div>
        <div className="col-md-6">
          <label className="form-label fw-semibold">Domain <span className="text-danger">*</span></label>
          <select className="form-select" name="domain" value={form.domain} onChange={updateField} required>
            <option value="" disabled>Select a domain</option>
            {domains.map((domain) => <option key={domain}>{domain}</option>)}
          </select>
        </div>
      </div>

      <div className="mb-3">
        <label className="form-label fw-semibold">Description <span className="text-danger">*</span></label>
        <textarea className="form-control" name="description" value={form.description} onChange={updateField} placeholder="What does this agent help with?" rows="3" maxLength="240" required />
        <div className="form-text text-end">{form.description.length}/240</div>
      </div>

      <div className="mb-3">
        <label className="form-label fw-semibold">Instructions <span className="text-danger">*</span></label>
        <textarea className="form-control" name="prompt" value={form.prompt} onChange={updateField} placeholder="Describe how the agent should respond, what it should know, and any rules it should follow." rows="7" required />
        <div className="form-text">Be specific about the agent’s role, tone, and boundaries.</div>
      </div>

      <fieldset className="border-top pt-3 mb-3">
        <div className="d-flex align-items-center gap-2 mb-1">
          <legend className="h6 fw-bold mb-0 float-none w-auto p-0">Starting questions</legend>
          <span className="badge rounded-pill text-bg-light border text-secondary fw-normal">Optional</span>
        </div>
        <p className="text-muted small mb-3">Help people get started with a few example questions.</p>
        <div className="d-flex flex-column gap-2 mb-2">
          {questions.map((question, index) => (
            <div className="d-flex align-items-center gap-2" key={index}>
              <span className="question-number">{index + 1}</span>
              <input className="form-control" value={question} onChange={(event) => updateQuestion(index, event.target.value)} placeholder="e.g. When is the next payroll date?" aria-label={`Starting question ${index + 1}`} />
              {questions.length > 1 && (
                <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setQuestions((current) => current.filter((_, i) => i !== index))} aria-label={`Remove question ${index + 1}`}>
                  <i className="bi bi-x-lg" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button className="btn btn-link btn-sm ps-0 text-decoration-none fw-semibold" type="button" onClick={() => setQuestions((current) => [...current, ''])}>+ Add another question</button>
      </fieldset>
    </>
  )
}

function App() {
  const [form, setForm] = useState({ name: '', domain: '', description: '', prompt: '' })
  const [questions, setQuestions] = useState([''])
  const [status, setStatus] = useState(() => window.location.pathname === '/agents/new' ? 'form' : 'list')
  const [agents, setAgents] = useState([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [selectedModel, setSelectedModel] = useState(MODEL_OPTIONS[0].id)
  const [templateSearch, setTemplateSearch] = useState('')
  const [notice, setNotice] = useState(null)
  const [pendingScroll, setPendingScroll] = useState(null)

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
      const configMatch = path.match(/^\/ai-studio\/templates\/([^/]+)\/config$/)

      if (path === '/agents/new') {
        setEditingId(null)
        setSelectedTemplate(null)
        setForm({ name: '', domain: '', description: '', prompt: '' })
        setQuestions([''])
        setStatus('form')
      } else if (match && match[1] !== 'new') {
        const agent = agents.find(({ id }) => String(id) === decodeURIComponent(match[1]))
        if (agent) {
          setForm({ name: agent.name, domain: agent.domain, description: agent.description, prompt: agent.instructions || '' })
          setQuestions(agent.questions?.length ? agent.questions : [''])
          setEditingId(agent.id)
          setSelectedTemplate(null)
          setStatus('form')
        } else {
          window.history.replaceState({}, '', '/agents')
          setStatus('list')
        }
      } else if (configMatch) {
        const template = TEMPLATES.find(({ id }) => id === configMatch[1])
        if (template) {
          setForm({ name: template.name, domain: template.domain, description: template.description, prompt: template.instructions })
          setQuestions(template.questions.length ? template.questions : [''])
          setEditingId(null)
          setSelectedTemplate(template)
          setSelectedModel(template.model)
          setStatus('studio-config')
        } else {
          window.history.replaceState({}, '', '/ai-studio')
          setSelectedTemplate(null)
          setStatus('studio')
        }
      } else if (path === '/agents') {
        setStatus('list')
      } else {
        if (path !== '/ai-studio') window.history.replaceState({}, '', '/ai-studio')
        setSelectedTemplate(null)
        setStatus('studio')
      }
    }

    loadRoute()
    window.addEventListener('popstate', loadRoute)
    return () => window.removeEventListener('popstate', loadRoute)
  }, [agents, dataLoaded])

  useEffect(() => {
    if (!pendingScroll || status !== 'studio') return
    const el = document.getElementById(pendingScroll)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setPendingScroll(null)
  }, [pendingScroll, status])

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
      if (selectedTemplate) {
        setSelectedTemplate(null)
        goTo('/ai-studio')
        setStatus('studio')
      } else {
        goTo('/agents')
        setStatus('list')
      }
    } catch (requestError) {
      setError(`${requestError.message} Make sure Django is running on port 8000.`)
      setStatus('form')
    }
  }

  const startNewAgent = () => {
    setForm({ name: '', domain: '', description: '', prompt: '' })
    setQuestions([''])
    setEditingId(null)
    setSelectedTemplate(null)
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
    setSelectedTemplate(null)
    goTo(`/agents/${encodeURIComponent(agent.id)}`)
    setStatus('form')
  }

  const openTemplate = (template) => {
    setForm({ name: template.name, domain: template.domain, description: template.description, prompt: template.instructions })
    setQuestions(template.questions.length ? template.questions : [''])
    setEditingId(null)
    setSelectedTemplate(template)
    setSelectedModel(template.model)
    goTo(`/ai-studio/templates/${template.id}/config`)
    setStatus('studio-config')
  }

  const cancelStudioConfig = () => {
    setSelectedTemplate(null)
    goTo('/ai-studio')
    setStatus('studio')
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

  const handleNav = (item) => {
    if (item.soon) {
      setNotice(`${item.label} is coming soon.`)
      return
    }
    if (item.anchor) {
      if (status !== 'studio') {
        setSelectedTemplate(null)
        goTo('/ai-studio')
        setStatus('studio')
      }
      setPendingScroll(item.anchor)
      return
    }
    if (item.path === '/ai-studio') setSelectedTemplate(null)
    goTo(item.path)
    setStatus(item.path === '/agents' ? 'list' : 'studio')
  }

  const activeNavKey = status === 'list' || (status === 'form' && !selectedTemplate)
    ? 'my-agents'
    : (status === 'studio' || status === 'studio-config')
      ? 'templates'
      : null

  if (status === 'loading') {
    return (
      <main className="d-flex flex-column align-items-center justify-content-center vh-100 text-center px-3" aria-live="polite" aria-busy="true">
        <div className="spinner-border text-dark mb-3" role="status" style={{ width: 48, height: 48 }}>
          <span className="visually-hidden">Loading</span>
        </div>
        <h2 className="h5 fw-bold mb-1">{editingId ? 'Updating your agent' : 'Creating your agent'}</h2>
        <p className="text-muted mb-0">{editingId ? 'Saving the latest agent details…' : selectedTemplate ? `Setting up your ${selectedTemplate.name}…` : 'Preparing its instructions and starting questions…'}</p>
      </main>
    )
  }

  if (!dataLoaded && status !== 'form') {
    return (
      <main className="d-flex flex-column align-items-center justify-content-center vh-100 text-center px-3" aria-live="polite" aria-busy="true">
        <div className="spinner-border text-dark mb-3" role="status" style={{ width: 48, height: 48 }}>
          <span className="visually-hidden">Loading</span>
        </div>
        <h2 className="h5 fw-bold mb-1">Loading agents</h2>
        <p className="text-muted mb-0">Fetching the available agents…</p>
      </main>
    )
  }

  if (status === 'studio') {
    const query = templateSearch.trim().toLowerCase()
    const filteredTemplates = TEMPLATES.filter((template) => !query
      || template.name.toLowerCase().includes(query)
      || template.description.toLowerCase().includes(query))
    const exampleTemplate = TEMPLATES.find((template) => template.id === 'anomaly-detection')

    return (
      <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice(null)} breadcrumb={['Agent Studio', 'Templates']}>
        <div className="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-4">
          <div>
            <h1 className="h4 fw-bold mb-1">Create Agent from Template</h1>
            <p className="text-muted mb-0">Choose a template that matches the runtime behavior you need.</p>
          </div>
          <div className="d-flex align-items-center gap-2">
            <div className="input-group">
              <span className="input-group-text bg-white"><i className="bi bi-search text-secondary" /></span>
              <input
                type="search"
                className="form-control"
                style={{ width: 220 }}
                value={templateSearch}
                onChange={(event) => setTemplateSearch(event.target.value)}
                placeholder="Search templates…"
                aria-label="Search templates"
              />
            </div>
            <button
              type="button"
              className="btn btn-outline-secondary text-nowrap"
              onClick={() => setNotice('Creating custom templates is coming soon — use the “Custom Agent” template below to start from scratch.')}
            >
              <i className="bi bi-plus-lg me-1" /> Create template
            </button>
          </div>
        </div>

        <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3 mb-4" aria-label="Agent templates">
          {filteredTemplates.map((template) => (
            <div className="col" key={template.id}>
              <div className={`card h-100 border-0 shadow-sm template-card accent-${template.accent}`}>
                <div className="card-body d-flex flex-column">
                  <div className="template-icon mb-3"><i className={`bi ${template.icon}`} /></div>
                  <h3 className="h6 fw-bold mb-1">{template.name}</h3>
                  <span className="template-runtime badge rounded-pill align-self-start mb-3">{template.runtime}</span>
                  <ul className="template-capabilities list-unstyled small text-secondary flex-grow-1 mb-3">
                    {template.capabilities.map((capability) => (
                      <li className="mb-1" key={capability}>{capability}</li>
                    ))}
                  </ul>
                  <button type="button" className="btn use-template-btn fw-semibold" onClick={() => openTemplate(template)}>Use Template</button>
                </div>
              </div>
            </div>
          ))}
          {filteredTemplates.length === 0 && <div className="col-12"><p className="text-muted mb-0">No templates match “{templateSearch}”.</p></div>}
        </div>

        {exampleTemplate && (
          <div className={`card border-0 shadow-sm mb-4 example-panel accent-${exampleTemplate.accent}`}>
            <div className="card-body d-flex flex-wrap align-items-center justify-content-between gap-4">
              <div>
                <span className="d-block text-uppercase fw-bold example-eyebrow small mb-1">Example</span>
                <h3 className="h6 fw-bold mb-0">Configure {exampleTemplate.name}</h3>
              </div>
              <div className="d-flex flex-wrap gap-4">
                <div>
                  <div className="text-uppercase text-secondary small fw-semibold mb-1">Domain</div>
                  <div className="fw-semibold">{exampleTemplate.domain} / Payrun</div>
                </div>
                <div>
                  <div className="text-uppercase text-secondary small fw-semibold mb-1">Runtime</div>
                  <div className="fw-semibold">{exampleTemplate.runtimeDetail}</div>
                </div>
                <div>
                  <div className="text-uppercase text-secondary small fw-semibold mb-1">Add Tools / APIs</div>
                  <div className="fw-semibold">{exampleTemplate.tools}</div>
                </div>
              </div>
              <button type="button" className="btn btn-dark d-inline-flex align-items-center gap-2" onClick={() => openTemplate(exampleTemplate)}>
                Configure <i className="bi bi-arrow-right" />
              </button>
            </div>
          </div>
        )}

        <div className="card border-0 shadow-sm" id="agent-registry" aria-label="Agent registry">
          <div className="card-body">
            <h2 className="h6 fw-bold mb-1">Agent registry</h2>
            <p className="text-muted small mb-3">Agents built from templates and attached to your services.</p>
            {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}
            {agents.length === 0 ? (
              <p className="text-muted small mb-0">No agents yet — use a template above to create your first one.</p>
            ) : (
              <div className="list-group list-group-flush">
                {agents.map((agent) => (
                  <button type="button" className="list-group-item list-group-item-action d-flex align-items-center gap-3 px-0" key={agent.id} onClick={() => openAgent(agent)}>
                    <span className="registry-icon"><i className="bi bi-stars" /></span>
                    <span className="flex-grow-1 text-start text-truncate">
                      <span className="d-block fw-semibold">{agent.name}</span>
                      <span className="d-block text-muted small text-truncate">{agent.description}</span>
                    </span>
                    <span className={`badge ${domainClass(agent.domain)}`}>{agent.domain}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </AppShell>
    )
  }

  if (status === 'studio-config' && selectedTemplate) {
    return (
      <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice(null)} breadcrumb={['Agent Studio', `Configure · ${selectedTemplate.name}`]}>
        <div className="row g-4">
          <div className="col-lg-8">
            <div className="card border-0 shadow-sm">
              <div className="card-body p-4 p-xl-5">
                <div className="mb-4">
                  <span className="text-uppercase small fw-bold text-secondary">Agent Studio · Configuration</span>
                  <h1 className="h4 fw-bold mt-1 mb-1">Configure {selectedTemplate.name}</h1>
                  <p className="text-muted mb-0">Review the template defaults, choose a model, and submit to add it to your agent registry.</p>
                </div>

                <form onSubmit={createAgent}>
                  {error && <div className="alert alert-danger py-2 small">{error}</div>}

                  <div className="row g-3 mb-3 pb-3 border-bottom">
                    <div className="col-md-6">
                      <label className="form-label fw-semibold">Template ID</label>
                      <input className="form-control" value={selectedTemplate.id} disabled />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label fw-semibold">Model</label>
                      <select className="form-select" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                        {MODEL_OPTIONS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                      </select>
                    </div>
                  </div>

                  <AgentFields form={form} updateField={updateField} questions={questions} updateQuestion={updateQuestion} setQuestions={setQuestions} />

                  <div className="d-flex justify-content-end gap-2 pt-4 mt-2 border-top">
                    <button className="btn btn-outline-secondary" type="button" onClick={cancelStudioConfig}>Cancel</button>
                    <button className="btn btn-dark d-inline-flex align-items-center gap-2" type="submit">Create agent <i className="bi bi-arrow-right" /></button>
                  </div>
                </form>
              </div>
            </div>
          </div>

          <div className="col-lg-4">
            <div className={`card border-0 shadow-sm accent-${selectedTemplate.accent}`} style={{ position: 'sticky', top: 24 }}>
              <div className="card-body">
                <div className="template-icon mb-3"><i className={`bi ${selectedTemplate.icon}`} /></div>
                <div className="text-uppercase small fw-bold text-secondary mb-1">Your agent</div>
                <h2 className="h5 fw-bold mb-2">{form.name || selectedTemplate.name}</h2>
                <p className="text-muted small mb-3">{form.description || selectedTemplate.description}</p>
                <span className={`badge ${domainClass(form.domain || selectedTemplate.domain)}`}>{form.domain || selectedTemplate.domain}</span>
              </div>
            </div>
          </div>
        </div>
      </AppShell>
    )
  }

  if (status === 'list') {
    return (
      <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice(null)} breadcrumb={['Agent Studio', 'My Agents']}>
        <div className="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-4">
          <div>
            <h1 className="h4 fw-bold mb-1">Available agents</h1>
            <p className="text-muted mb-0">Choose an agent to get help, or create one for a new workflow.</p>
          </div>
          <button className="btn btn-dark d-inline-flex align-items-center gap-2" type="button" onClick={startNewAgent}>
            <i className="bi bi-plus-lg" /> Create agent
          </button>
        </div>
        <div className="card border-0 shadow-sm">
          <div className="card-body">
            {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}
            <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-3 g-3" aria-label="Available agents">
              {agents.map((agent, index) => (
                <div className="col" key={agent.id}>
                  <div className="card h-100 border-0 shadow-sm position-relative">
                    {index === 0 && <span className="badge text-bg-success position-absolute top-0 end-0 m-2">Just created</span>}
                    <div className="card-body d-flex flex-column">
                      <div className="d-flex align-items-center justify-content-between mb-3">
                        <div className="template-icon accent-neutral"><i className="bi bi-stars" /></div>
                        <span className={`badge ${domainClass(agent.domain)}`}>{agent.domain}</span>
                      </div>
                      <h2 className="h6 fw-bold mb-2">{agent.name}</h2>
                      <p className="text-muted small flex-grow-1">{agent.description}</p>
                      <button type="button" className="btn btn-link btn-sm ps-0 text-decoration-none fw-semibold align-self-start" onClick={() => openAgent(agent)}>
                        Open agent <i className="bi bi-arrow-right ms-1" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice(null)} breadcrumb={['Agent Studio', editingId ? 'Edit agent' : 'New agent']}>
      <div className="row g-4">
        <div className="col-lg-8">
          <div className="card border-0 shadow-sm">
            <div className="card-body p-4 p-xl-5">
              <div className="mb-4">
                <h1 className="h4 fw-bold mb-1">{editingId ? 'Edit agent' : 'Create a new agent'}</h1>
                <p className="text-muted mb-0">{editingId ? 'Update this agent’s details, instructions, and starting questions.' : 'Give your agent the context and guidance it needs to help your team.'}</p>
              </div>

              <form onSubmit={createAgent}>
                {error && <div className="alert alert-danger py-2 small">{error}</div>}

                <AgentFields form={form} updateField={updateField} questions={questions} updateQuestion={updateQuestion} setQuestions={setQuestions} />

                <div className="d-flex justify-content-end gap-2 pt-4 mt-2 border-top">
                  <button className="btn btn-outline-secondary" type="button" onClick={cancelForm}>Cancel</button>
                  <button className="btn btn-dark d-inline-flex align-items-center gap-2" type="submit">
                    {editingId ? 'Save changes' : 'Create agent'} <i className="bi bi-arrow-right" />
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card border-0 shadow-sm accent-neutral" style={{ position: 'sticky', top: 24 }}>
            <div className="card-body">
              <div className="template-icon mb-3"><i className="bi bi-stars" /></div>
              <div className="text-uppercase small fw-bold text-secondary mb-1">Your agent</div>
              <h2 className="h5 fw-bold mb-2">{form.name || 'Payroll Assistant'}</h2>
              <p className="text-muted small mb-3">{form.description || 'A helpful expert, ready to support your team.'}</p>
              {form.domain && <span className={`badge ${domainClass(form.domain)}`}>{form.domain}</span>}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}

export default App
