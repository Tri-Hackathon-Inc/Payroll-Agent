import { useEffect, useState } from 'react'
import './App.css'

const DOMAINS = [
  { id: 'hr', label: 'HR', icon: 'bi-people', description: 'Policies, onboarding, and general people questions.' },
  { id: 'payroll', label: 'Payroll', icon: 'bi-cash-coin', description: 'Payrun anomalies, summaries, and payroll questions.' },
  { id: 'insurance', label: 'Insurance', icon: 'bi-shield-check', description: 'Coverage, claims, and policy questions.' },
  { id: 'benefits', label: 'Benefits', icon: 'bi-heart-pulse', description: 'Stock matching, HSA, and other benefits questions.' },
  { id: 'time-off', label: 'Time off', icon: 'bi-calendar-week', description: 'PTO balances, requests, and time-off policy.' },
]

const domains = DOMAINS.map((domain) => domain.label)

const TEMPLATES = [
  {
    id: 'anomaly-detection',
    name: 'Anomaly Detection Agent',
    domain: 'Payroll',
    icon: 'bi-activity',
    runtime: 'REAL-TIME',
    description: 'Watches payrun changes in real time and flags amounts that look off versus history.',
    instructions: "On every payrun change, compare the new amount against the employee's historical payruns. Flag any change greater than the configured threshold (default 2000) and summarize what changed and why it looks unusual.",
    questions: ['Why did this payrun amount change?', 'Show me the flagged changes for this payrun.'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'summarizer',
    name: 'Summarizer Agent',
    domain: 'Payroll',
    icon: 'bi-file-earmark-text',
    runtime: 'OFFLINE',
    description: 'Summarizes a payrun or employee record so admins get the key numbers at a glance.',
    instructions: 'Fetch the employee and payrun details for the selected record and produce a short summary covering rate changes, hours, earnings, and taxes. Keep it to a few bullet points.',
    questions: ['Summarize this payrun.', "Summarize this employee's earnings and taxes."],
    model: 'llama-3.1-70b',
  },
  {
    id: 'general-query',
    name: 'General Query Agent',
    domain: 'Payroll',
    icon: 'bi-chat-dots',
    runtime: 'INTERACTIVE',
    description: 'Answers everyday payroll questions like pay dates, rates, and hours.',
    instructions: 'Answer employee and admin questions about payroll using the current payrun data. Be concise, cite the specific payrun or employee record you used, and say when you are not sure.',
    questions: ['When is the next payroll date?', 'What is the overall payrun amount this cycle?'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'custom',
    name: 'Custom Agent',
    domain: 'Payroll',
    icon: 'bi-sliders',
    runtime: 'CONFIGURABLE',
    description: 'Start from a blank agent and write your own instructions.',
    instructions: '',
    questions: [''],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'hr-policy',
    name: 'HR Policy Agent',
    domain: 'HR',
    icon: 'bi-people',
    runtime: 'INTERACTIVE',
    description: 'Answers HR policy questions like leave, conduct, and onboarding.',
    instructions: 'Answer employee questions about HR policies using the company handbook. Be concise and say when a question needs to go to HR directly.',
    questions: ['What is the company dress code?', 'How do I report a workplace issue?'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'hr-general',
    name: 'General Agent',
    domain: 'HR',
    icon: 'bi-chat-dots',
    runtime: 'INTERACTIVE',
    description: 'Answers general questions using public knowledge, for anything outside HR policy.',
    instructions: 'Answer general questions as helpfully as possible using public knowledge. Say clearly when a question is really an HR policy question that the HR Policy Agent should handle instead.',
    questions: ['What is a typical PTO policy?', "What's a 401k?"],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'insurance-policy',
    name: 'Policy Agent',
    domain: 'Insurance',
    icon: 'bi-shield-check',
    runtime: 'INTERACTIVE',
    description: 'Answers questions about coverage, claims, and policy terms.',
    instructions: 'Answer employee questions about their insurance policy, coverage, and claims using the plan documents. Be concise and cite the relevant plan section when possible.',
    questions: ['What does my plan cover?', 'How do I file a claim?'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'insurance-general',
    name: 'General Agent',
    domain: 'Insurance',
    icon: 'bi-chat-dots',
    runtime: 'INTERACTIVE',
    description: 'Answers general insurance questions using public knowledge.',
    instructions: 'Answer general insurance questions as helpfully as possible using public knowledge. Say clearly when a question is plan-specific and should go to the Policy Agent instead.',
    questions: ['What is a deductible?', 'What is the difference between HMO and PPO?'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'benefits-agent',
    name: 'Benefits Agent',
    domain: 'Benefits',
    icon: 'bi-heart-pulse',
    runtime: 'INTERACTIVE',
    description: 'Answers questions about stock matching, HSA, and other benefits.',
    instructions: 'Answer employee questions about benefits such as stock purchase matching, HSA/FSA accounts, and caregiving policies using the benefits guide. Be concise and cite the relevant section.',
    questions: ['How does stock matching work?', 'What can I use my HSA for?'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'benefits-general',
    name: 'General Agent',
    domain: 'Benefits',
    icon: 'bi-chat-dots',
    runtime: 'INTERACTIVE',
    description: 'Answers general benefits questions using public knowledge.',
    instructions: 'Answer general benefits questions as helpfully as possible using public knowledge. Say clearly when a question is plan-specific and should go to the Benefits Agent instead.',
    questions: ['What is an HSA?', 'What is typical employer stock matching?'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'timeoff-agent',
    name: 'Time Off Agent',
    domain: 'Time off',
    icon: 'bi-calendar-week',
    runtime: 'INTERACTIVE',
    description: 'Answers questions about PTO balances, requests, and time-off policy.',
    instructions: "Answer employee questions about their PTO balance, how to request time off, and the company's time-off policy. Be concise and cite the relevant policy section.",
    questions: ['How much PTO do I have left?', 'How do I request time off?'],
    model: 'qwen-2.5-72b',
  },
  {
    id: 'timeoff-general',
    name: 'General Agent',
    domain: 'Time off',
    icon: 'bi-chat-dots',
    runtime: 'INTERACTIVE',
    description: 'Answers general time-off questions using public knowledge.',
    instructions: 'Answer general time-off questions as helpfully as possible using public knowledge. Say clearly when a question is policy-specific and should go to the Time Off Agent instead.',
    questions: ['What is a typical PTO accrual rate?', 'What is the difference between PTO and sick leave?'],
    model: 'qwen-2.5-72b',
  },
]

const MODEL_OPTIONS = [
  { id: 'qwen-2.5-72b', label: 'Qwen 2.5 · 72B (open source)' },
  { id: 'llama-3.1-70b', label: 'Llama 3.1 · 70B (open source)' },
  { id: 'mistral-large', label: 'Mistral Large' },
  { id: 'bedrock-claude', label: 'AWS Bedrock · Claude' },
]

const TOOL_OPTIONS = ['Payrun API', 'Employee Directory API', 'Benefits API']

const NAV_GROUPS = [
  {
    label: 'Build',
    items: [
      { key: 'templates', label: 'Templates', icon: 'bi-grid-1x2', path: '/ai-studio' },
      { key: 'my-agents', label: 'My Agents', icon: 'bi-robot', path: '/agents' },
      { key: 'tools', label: 'Tools & APIs', icon: 'bi-plug', soon: true },
      { key: 'models', label: 'Models', icon: 'bi-cpu', soon: true },
    ],
  },
  {
    label: 'Manage',
    items: [
      { key: 'registry', label: 'Agent Registry', icon: 'bi-collection', soon: true },
      { key: 'evaluation', label: 'Evaluation', icon: 'bi-graph-up', soon: true },
    ],
  },
]

const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items)

function domainSlug(domain) {
  return domain.toLowerCase().replace(' ', '-')
}

function domainClass(domain) {
  return `domain-badge domain-${domainSlug(domain)}`
}

function Sidebar({ activeKey, onNavigate }) {
  return (
    <aside className="app-sidebar d-flex flex-column flex-shrink-0 p-3">
      <div className="d-flex align-items-center gap-2 px-1 mb-1">
        <span className="sidebar-mark"><i className="bi bi-stars" /></span>
        <div className="d-flex flex-column">
          <span className="text-white fw-bold text-uppercase sidebar-brand">Agent Studio</span>
          <span className="sidebar-subtitle">Payroll AI Platform</span>
        </div>
      </div>
      <hr className="sidebar-divider mt-3 mb-3" />
      {NAV_GROUPS.map((group) => (
        <div className="mb-3" key={group.label}>
          <div className="sidebar-group-label px-2 mb-2">{group.label}</div>
          <ul className="nav nav-pills flex-column gap-1">
            {group.items.map((item) => (
              <li className="nav-item" key={item.key}>
                <button
                  type="button"
                  className={`nav-link sidebar-link d-flex align-items-center gap-2 w-100 text-start${activeKey === item.key ? ' active' : ''}`}
                  onClick={() => onNavigate(item)}
                >
                  <span className="sidebar-icon"><i className={`bi ${item.icon}`} /></span>
                  <span className="flex-grow-1">{item.label}</span>
                  {item.soon && <span className="badge rounded-pill sidebar-soon">Soon</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  )
}

function AppShell({ activeKey, onNavigate, notice, onDismissNotice, children }) {
  return (
    <div className="app-shell d-flex">
      <Sidebar activeKey={activeKey} onNavigate={onNavigate} />
      <div className="flex-grow-1 d-flex flex-column min-vw-0">
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
        <div className="d-flex flex-column gap-2 mb-2 mt-2">
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
  const [selectedDomain, setSelectedDomain] = useState(null)
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [selectedModel, setSelectedModel] = useState(MODEL_OPTIONS[0].id)
  const [attachedTools, setAttachedTools] = useState(TOOL_OPTIONS)
  const [templateSearch, setTemplateSearch] = useState('')
  const [agentSearch, setAgentSearch] = useState('')
  const [domainSearch, setDomainSearch] = useState('')
  const [notice, setNotice] = useState(null)

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
      const domainMatch = path.match(/^\/ai-studio\/domains\/([^/]+)$/)

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
          setSelectedModel(agent.model || MODEL_OPTIONS[0].id)
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
          setSelectedDomain(template.domain)
          setSelectedTemplate(template)
          setSelectedModel(template.model)
          setAttachedTools(TOOL_OPTIONS)
          setStatus('studio-config')
        } else {
          window.history.replaceState({}, '', '/ai-studio')
          setSelectedDomain(null)
          setSelectedTemplate(null)
          setStatus('studio-domains')
        }
      } else if (domainMatch) {
        const domain = DOMAINS.find(({ id }) => id === domainMatch[1])
        if (domain) {
          setSelectedDomain(domain.label)
          setSelectedTemplate(null)
          setStatus('studio')
        } else {
          window.history.replaceState({}, '', '/ai-studio')
          setSelectedDomain(null)
          setStatus('studio-domains')
        }
      } else if (path === '/agents') {
        setStatus('list')
      } else {
        if (path !== '/ai-studio') window.history.replaceState({}, '', '/ai-studio')
        setSelectedDomain(null)
        setSelectedTemplate(null)
        setStatus('studio-domains')
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
  const toggleTool = (tool) => {
    setAttachedTools((current) => current.includes(tool)
      ? current.filter((attached) => attached !== tool)
      : [...current, tool])
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
          model: selectedModel,
          questions: questions.filter((question) => question.trim()),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to save the agent.')

      setAgents((current) => editingId
        ? current.map((agent) => agent.id === editingId ? data : agent)
        : [data, ...current])
      if (selectedTemplate) {
        const domain = selectedTemplate.domain
        setSelectedTemplate(null)
        setSelectedDomain(domain)
        goTo(`/ai-studio/domains/${domainSlug(domain)}`)
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
    setSelectedModel(agent.model || MODEL_OPTIONS[0].id)
    goTo(`/agents/${encodeURIComponent(agent.id)}`)
    setStatus('form')
  }

  const openDomain = (domain) => {
    setSelectedDomain(domain.label)
    setSelectedTemplate(null)
    setTemplateSearch('')
    goTo(`/ai-studio/domains/${domain.id}`)
    setStatus('studio')
  }

  const backToDomains = () => {
    setSelectedDomain(null)
    setSelectedTemplate(null)
    goTo('/ai-studio')
    setStatus('studio-domains')
  }

  const openTemplate = (template) => {
    setForm({ name: template.name, domain: template.domain, description: template.description, prompt: template.instructions })
    setQuestions(template.questions.length ? template.questions : [''])
    setEditingId(null)
    setSelectedDomain(template.domain)
    setSelectedTemplate(template)
    setSelectedModel(template.model)
    setAttachedTools(TOOL_OPTIONS)
    goTo(`/ai-studio/templates/${template.id}/config`)
    setStatus('studio-config')
  }

  const cancelStudioConfig = () => {
    const domain = selectedTemplate?.domain
    setSelectedTemplate(null)
    if (domain) {
      setSelectedDomain(domain)
      goTo(`/ai-studio/domains/${domainSlug(domain)}`)
      setStatus('studio')
    } else {
      goTo('/ai-studio')
      setStatus('studio-domains')
    }
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
    if (item.path === '/ai-studio') {
      setSelectedDomain(null)
      setSelectedTemplate(null)
      goTo(item.path)
      setStatus('studio-domains')
      return
    }
    goTo(item.path)
    setStatus(item.path === '/agents' ? 'list' : 'studio-domains')
  }

  const activeNavKey = status === 'list' || (status === 'form' && !selectedTemplate)
    ? 'my-agents'
    : (status === 'studio-domains' || status === 'studio' || status === 'studio-config')
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

  if (status === 'studio-domains') {
    const domainQuery = domainSearch.trim().toLowerCase()
    const filteredDomains = DOMAINS.filter((domain) => !domainQuery
      || domain.label.toLowerCase().includes(domainQuery)
      || domain.description.toLowerCase().includes(domainQuery))

    return (
      <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice(null)} breadcrumb={['Agent Studio', 'Templates']}>
        <div className="d-flex flex-wrap align-items-center gap-3 mb-4">
          <div className="input-group flex-grow-1">
            <span className="input-group-text bg-white"><i className="bi bi-search text-secondary" /></span>
            <input
              type="search"
              className="form-control"
              value={domainSearch}
              onChange={(event) => setDomainSearch(event.target.value)}
              placeholder="Search domains…"
              aria-label="Search domains"
            />
          </div>
        </div>

        <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-3 g-3 mb-4" aria-label="Domains">
          {filteredDomains.length === 0 && <div className="col-12"><p className="text-muted mb-0">No domains match “{domainSearch}”.</p></div>}
          {filteredDomains.map((domain) => (
            <div className="col" key={domain.id}>
              <div
                className="card h-100 border-0 shadow-sm template-card domain-card"
                role="button"
                tabIndex={0}
                onClick={() => openDomain(domain)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openDomain(domain) }}
              >
                <div className="card-body d-flex flex-column">
                  <div className="template-icon accent-neutral mb-3"><i className={`bi ${domain.icon}`} /></div>
                  <h3 className="h6 fw-bold mb-1">{domain.label}</h3>
                  <p className="text-muted small flex-grow-1 mb-3">{domain.description}</p>
                  <span className="fw-semibold small d-inline-flex align-items-center gap-1">Browse agents <i className="bi bi-arrow-right" /></span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="card border-0 shadow-sm" id="agent-registry" aria-label="Agent registry">
          <div className="card-body">
            <h2 className="h6 fw-bold mb-3">Agent registry</h2>
            {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}
            {agents.length === 0 ? (
              <p className="text-muted small mb-0">No agents yet — pick a domain above to create your first one.</p>
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

  if (status === 'studio') {
    const query = templateSearch.trim().toLowerCase()
    const domainTemplates = TEMPLATES.filter((template) => template.domain === selectedDomain)
    const filteredTemplates = domainTemplates.filter((template) => !query
      || template.name.toLowerCase().includes(query)
      || template.description.toLowerCase().includes(query))

    return (
      <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice(null)} breadcrumb={['Agent Studio', selectedDomain || 'Templates']}>
        <button type="button" className="btn btn-link btn-sm ps-0 text-decoration-none fw-semibold mb-2" onClick={backToDomains}>
          <i className="bi bi-arrow-left me-1" /> All domains
        </button>
        <div className="d-flex flex-wrap align-items-center gap-3 mb-4">
          <div className="d-flex align-items-center gap-2">
            <div className="input-group">
              <span className="input-group-text bg-white"><i className="bi bi-search text-secondary" /></span>
              <input
                type="search"
                className="form-control"
                style={{ width: 900 }}
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

        <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3" aria-label="Agent templates">
          {filteredTemplates.map((template) => (
            <div className="col" key={template.id}>
              <div className="card h-100 border-0 shadow-sm template-card accent-neutral">
                <div className="card-body d-flex flex-column">
                  <div className="template-icon mb-3"><i className={`bi ${template.icon}`} /></div>
                  <h3 className="h6 fw-bold mb-1">{template.name}</h3>
                  <span className="template-runtime badge rounded-pill align-self-start mb-3">{template.runtime}</span>
                  <p className="text-secondary small flex-grow-1 mb-3">{template.description}</p>
                  <button type="button" className="btn btn-dark fw-semibold" onClick={() => openTemplate(template)}>Use Template</button>
                </div>
              </div>
            </div>
          ))}
          {filteredTemplates.length === 0 && <div className="col-12"><p className="text-muted mb-0">No templates match “{templateSearch}”.</p></div>}
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

                  <div className="row g-3 mb-3 pb-3 border-bottom">
                    <div className="col-md-4">
                      <label className="form-label fw-semibold">Service visibility</label>
                      <select className="form-select" defaultValue="internal">
                        <option value="internal">Internal only</option>
                        <option value="team">Team</option>
                        <option value="public">Public</option>
                      </select>
                    </div>
                    <div className="col-md-4">
                      <label className="form-label fw-semibold">Rules access</label>
                      <input className="form-control" defaultValue="Read only" placeholder="e.g. Read only" />
                    </div>
                    <div className="col-md-4">
                      <label className="form-label fw-semibold">Created at</label>
                      <input className="form-control" value={new Date().toLocaleDateString()} disabled />
                    </div>
                  </div>

                  {selectedTemplate.id === 'anomaly-detection' && (
                    <fieldset className="border-bottom pb-3 mb-3">
                      <legend className="h6 fw-bold mb-1 float-none w-auto p-0">Detection settings</legend>
                      <p className="text-muted small mb-3">Anomaly Detection runs automatically in the background instead of waiting for a question — configure what it watches.</p>
                      <div className="row g-3">
                        <div className="col-md-6">
                          <label className="form-label fw-semibold">Watches</label>
                          <input className="form-control" defaultValue="Payrun changes" />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label fw-semibold">Detection threshold</label>
                          <input className="form-control" defaultValue="2000" />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label fw-semibold">Check frequency</label>
                          <select className="form-select" defaultValue="real-time">
                            <option value="real-time">Real-time</option>
                            <option value="hourly">Hourly</option>
                            <option value="daily">Daily</option>
                          </select>
                        </div>
                        <div className="col-md-6">
                          <label className="form-label fw-semibold">Notify</label>
                          <input className="form-control" defaultValue="payroll-admins@company.com" />
                        </div>
                      </div>
                    </fieldset>
                  )}

                  <AgentFields form={form} updateField={updateField} questions={questions} updateQuestion={updateQuestion} setQuestions={setQuestions} />

                  <fieldset className="border-top pt-3 mb-3">
                    <div className="d-flex align-items-center gap-2 mb-1">
                      <legend className="h6 fw-bold mb-0 float-none w-auto p-0">Attach tools & APIs</legend>
                      <span className="badge rounded-pill text-bg-light border text-secondary fw-normal">{attachedTools.length} attached</span>
                    </div>
                    <p className="text-muted small mb-2">Choose which tools this agent can use. Full read/write access control is coming later — for now, an attached tool is fully accessible.</p>
                    <div className="d-flex flex-column gap-2">
                      {TOOL_OPTIONS.map((tool) => (
                        <div className="form-check" key={tool}>
                          <input
                            className="form-check-input"
                            type="checkbox"
                            checked={attachedTools.includes(tool)}
                            onChange={() => toggleTool(tool)}
                            id={`tool-${tool}`}
                          />
                          <label className="form-check-label small" htmlFor={`tool-${tool}`}>{tool}</label>
                        </div>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset className="border-top pt-3 mb-3">
                    <legend className="h6 fw-bold mb-1 float-none w-auto p-0">Out-of-the-box capabilities</legend>
                    <div className="form-check">
                      <input className="form-check-input" type="checkbox" defaultChecked id="email-alerts" />
                      <label className="form-check-label small" htmlFor="email-alerts">Send email alerts</label>
                    </div>
                    <p className="text-muted small mb-0">Other channels (Teams, Slack, SMS) are coming soon.</p>
                  </fieldset>

                  <div className="d-flex justify-content-end gap-2 pt-4 mt-2 border-top">
                    <button className="btn btn-outline-secondary" type="button" onClick={cancelStudioConfig}>Cancel</button>
                    <button className="btn btn-dark d-inline-flex align-items-center gap-2" type="submit">Create agent <i className="bi bi-arrow-right" /></button>
                  </div>
                </form>
              </div>
            </div>
          </div>

          <div className="col-lg-4">
            <div className="card border-0 shadow-sm accent-neutral" style={{ position: 'sticky', top: 24 }}>
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
    const query = agentSearch.trim().toLowerCase()
    const filteredAgents = agents.filter((agent) => !query
      || agent.name.toLowerCase().includes(query)
      || agent.description.toLowerCase().includes(query))

    return (
      <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice(null)} breadcrumb={['Agent Studio', 'My Agents']}>
        <div className="d-flex flex-wrap align-items-center gap-2 mb-4">
          <div className="input-group" style={{ maxWidth: 1000 }}>
            <span className="input-group-text bg-white"><i className="bi bi-search text-secondary" /></span>
            <input
              type="search"
              className="form-control"
              value={agentSearch}
              onChange={(event) => setAgentSearch(event.target.value)}
              placeholder="Search agents…"
              aria-label="Search agents"
            />
          </div>
          <button className="btn btn-dark d-inline-flex align-items-center gap-2 text-nowrap" type="button" onClick={startNewAgent}>
            <i className="bi bi-plus-lg" /> Create agent
          </button>
        </div>
        <div className="card border-0 shadow-sm">
          <div className="card-body">
            {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}
            {filteredAgents.length === 0 && (
              <p className="text-muted small mb-0">{query ? `No agents match “${agentSearch}”.` : 'No agents yet — create one to get started.'}</p>
            )}
            <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-3 g-3" aria-label="Available agents">
              {filteredAgents.map((agent) => (
                <div className="col" key={agent.id}>
                  <div className="card h-100 border-0 shadow-sm position-relative">
                    {agent.id === agents[0]?.id && <span className="badge text-bg-success position-absolute top-0 end-0 m-2">Just created</span>}
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
