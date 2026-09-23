import { useState } from 'react'
import { TEMPLATES } from './TemplatesPage.jsx'

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5c.45 5.38 3.12 8.05 8.5 8.5-5.38.45-8.05 3.12-8.5 8.5-.45-5.38-3.12-8.05-8.5-8.5 5.38-.45 8.05-3.12 8.5-8.5Z" />
    </svg>
  )
}

const DOMAINS = ['HR', 'Payroll', 'Time off']

const AGENT_TYPES = [
  { id: 'summarizer', label: 'Summarizer' },
  { id: 'general_query', label: 'General Query' },
  { id: 'anomaly_detection', label: 'Anomaly Detection' },
  { id: 'incident_generator', label: 'Incident Generator' },
]

const MODELS = [
  { id: 'claude_sonnet', label: 'Claude Sonnet 4.6' },
  { id: 'claude_haiku', label: 'Claude Haiku 4.5' },
  { id: 'llama_3', label: 'Llama 3.3 70B' },
  { id: 'mistral_large', label: 'Mistral Large' },
]

const PAGE_ATTACHMENTS = [
  { id: 'payrun_list', label: 'Payrun List' },
  { id: 'payrun_detail', label: 'Payrun Detail' },
  { id: 'employee_detail', label: 'Employee Detail' },
  { id: 'payrun_summary', label: 'Payrun Summary' },
]

const AVAILABLE_TOOLS = [
  { id: 'payroll_api', label: 'Payroll API', description: 'Access payroll records and calculations' },
  { id: 'historical_data', label: 'Historical Data', description: 'Query historical payrun patterns' },
  { id: 'alert_api', label: 'Alert API', description: 'Emit and route anomaly alerts' },
  { id: 'peo_api', label: 'PEO API', description: 'Update employee master data' },
  { id: 'rules_engine', label: 'Rules Engine', description: 'Validate against payroll business rules' },
  { id: 'validation_service', label: 'Validation Service', description: 'Cross-check pay data for compliance' },
]

function buildInitialForm(editingAgent, template) {
  if (editingAgent) {
    return {
      name: editingAgent.name || '',
      domain: editingAgent.domain || '',
      description: editingAgent.description || '',
      prompt: editingAgent.instructions || '',
      agentType: editingAgent.agent_type || '',
      model: editingAgent.model_used || '',
      pageAttachment: editingAgent.page_attachment || '',
      tools: editingAgent.tools || [],
    }
  }
  if (template) {
    return {
      name: '',
      domain: 'Payroll',
      description: '',
      prompt: template.defaultInstructions,
      agentType: template.agentType,
      model: 'claude_sonnet',
      pageAttachment: '',
      tools: template.defaultTools,
    }
  }
  return { name: '', domain: '', description: '', prompt: '', agentType: '', model: '', pageAttachment: '', tools: [] }
}

export default function AgentFormPage({ editingAgent, templateId, onSave, onCancel }) {
  const template = templateId ? TEMPLATES.find((t) => t.id === templateId) : null

  const [form, setForm] = useState(() => buildInitialForm(editingAgent, template))
  const [questions, setQuestions] = useState(
    editingAgent?.questions?.length ? editingAgent.questions : ['']
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isEditing = Boolean(editingAgent)

  const updateField = ({ target: { name, value } }) =>
    setForm((f) => ({ ...f, [name]: value }))

  const toggleTool = (toolId) =>
    setForm((f) => ({
      ...f,
      tools: f.tools.includes(toolId) ? f.tools.filter((t) => t !== toolId) : [...f.tools, toolId],
    }))

  const updateQuestion = (index, value) =>
    setQuestions((qs) => qs.map((q, i) => (i === index ? value : q)))

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setSaving(true)
    try {
      const payload = {
        ...(isEditing ? { id: editingAgent.id } : {}),
        name: form.name,
        domain: form.domain,
        description: form.description,
        instructions: form.prompt,
        agent_type: form.agentType,
        model_used: form.model,
        page_attachment: form.pageAttachment,
        tools: form.tools,
        questions: questions.filter((q) => q.trim()),
      }
      const res = await fetch('/api/agents/save/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Unable to save the agent.')
      onSave(data, isEditing)
    } catch (err) {
      setError(`${err.message} Make sure Django is running on port 8000.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="form-page">
      <section className="form-panel">
        <header className="page-header">
          {template && (
            <div className={`template-source-badge template-source-${template.runtimeKey}`}>
              {template.runtime} · {template.name} template
            </div>
          )}
          <div className="eyebrow"><SparkleIcon /> Agent builder</div>
          <h1>{isEditing ? 'Edit agent' : 'Create a new agent'}</h1>
          <p>
            {isEditing
              ? "Update this agent's details, instructions, and configuration."
              : 'Give your agent the context and guidance it needs to help your team.'}
          </p>
        </header>

        <form onSubmit={handleSubmit}>
          {error && <p className="error-banner" role="alert">{error}</p>}

          {/* Basic info */}
          <div className="form-grid">
            <label className="field">
              <span>Agent name <b>*</b></span>
              <input name="name" value={form.name} onChange={updateField} placeholder="e.g. Payroll Anomaly Watcher" required />
            </label>
            <label className="field">
              <span>Domain <b>*</b></span>
              <div className="select-wrap">
                <select name="domain" value={form.domain} onChange={updateField} required>
                  <option value="" disabled>Select a domain</option>
                  {DOMAINS.map((d) => <option key={d}>{d}</option>)}
                </select>
              </div>
            </label>
          </div>

          <label className="field">
            <span>Description <b>*</b></span>
            <textarea name="description" value={form.description} onChange={updateField}
              placeholder="What does this agent help with?" rows="3" maxLength="240" required />
            <small>{form.description.length}/240</small>
          </label>

          {/* Agent configuration */}
          <fieldset>
            <legend>Agent configuration</legend>
            <div className="legend-help">Define the type, model, and where this agent will live.</div>
            <div className="form-grid form-grid-three">
              <label className="field">
                <span>Agent type</span>
                <div className="select-wrap">
                  <select name="agentType" value={form.agentType} onChange={updateField}>
                    <option value="">Select type</option>
                    {AGENT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
              </label>
              <label className="field">
                <span>Model</span>
                <div className="select-wrap">
                  <select name="model" value={form.model} onChange={updateField}>
                    <option value="">Select model</option>
                    {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </div>
              </label>
              <label className="field">
                <span>Page to attach</span>
                <div className="select-wrap">
                  <select name="pageAttachment" value={form.pageAttachment} onChange={updateField}>
                    <option value="">Select page</option>
                    {PAGE_ATTACHMENTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
              </label>
            </div>
          </fieldset>

          {/* Instructions */}
          <label className="field">
            <span>Instructions <b>*</b></span>
            <textarea name="prompt" value={form.prompt} onChange={updateField}
              placeholder="Describe how the agent should respond, what it should know, and any rules it should follow."
              rows="7" required />
            <em>Be specific about the agent's role, tone, and boundaries.</em>
          </label>

          {/* Tools */}
          <fieldset>
            <legend>Tools &amp; APIs <span>Optional</span></legend>
            <div className="legend-help">Attach approved payroll tools this agent can call at runtime.</div>
            <div className="tools-grid">
              {AVAILABLE_TOOLS.map((tool) => (
                <label key={tool.id} className={`tool-item${form.tools.includes(tool.id) ? ' tool-item-checked' : ''}`}>
                  <input
                    type="checkbox"
                    className="tool-checkbox"
                    checked={form.tools.includes(tool.id)}
                    onChange={() => toggleTool(tool.id)}
                  />
                  <div className="tool-item-body">
                    <span className="tool-item-label">{tool.label}</span>
                    <span className="tool-item-desc">{tool.description}</span>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Starting questions */}
          <fieldset>
            <legend>Starting questions <span>Optional</span></legend>
            <p className="legend-help">Help people get started with a few example questions.</p>
            <div className="question-list">
              {questions.map((question, index) => (
                <div className="question-row" key={index}>
                  <span className="question-number">{index + 1}</span>
                  <input
                    value={question}
                    onChange={(e) => updateQuestion(index, e.target.value)}
                    placeholder="e.g. When is the next payroll date?"
                    aria-label={`Starting question ${index + 1}`}
                  />
                  {questions.length > 1 && (
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => setQuestions((qs) => qs.filter((_, i) => i !== index))}
                      aria-label={`Remove question ${index + 1}`}
                    >×</button>
                  )}
                </div>
              ))}
            </div>
            <button className="add-button" type="button" onClick={() => setQuestions((qs) => [...qs, ''])}>
              + Add another question
            </button>
          </fieldset>

          <footer className="form-footer">
            <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create agent'} <span>→</span>
            </button>
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
          {form.agentType && (
            <div className={`agent-type-badge agent-type-${form.agentType}`} style={{ marginBottom: 8 }}>
              {AGENT_TYPES.find((t) => t.id === form.agentType)?.label}
            </div>
          )}
          <div className="preview-domain">{form.domain || 'Domain'}</div>
          {form.tools.length > 0 && (
            <div className="preview-tools">
              {form.tools.map((toolId) => (
                <span key={toolId} className="preview-tool-chip">
                  {AVAILABLE_TOOLS.find((t) => t.id === toolId)?.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
