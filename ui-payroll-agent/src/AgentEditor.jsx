import { useEffect, useState } from 'react'
import { graphqlRequest } from './graphql/client'
import { CREATE_AGENT_MUTATION, TEMPLATE_QUERY, UPDATE_AGENT_MUTATION } from './graphql/operations'

export default function AgentEditor({ domain, templateId, agent, onSaved, onCancel }) {
  const [template, setTemplate] = useState(null)
  const [name, setName] = useState(agent?.name || '')
  const [config, setConfig] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  const [archived, setArchived] = useState(false)

  useEffect(() => {
    let active = true
    setLoadError('')
    graphqlRequest(TEMPLATE_QUERY, { id: templateId }).then(({ getTemplate: detail }) => {
      if (!active) return
      if (detail.config.domain !== domain.domain) throw new Error('This template is not available for the selected domain.')
      setTemplate(detail)
      setName(agent?.name || detail.name)
      setConfig(structuredClone(agent?.config || detail.config))
    }).catch(requestError => {
      if (!active) return
      if (agent && requestError.code === 'NOT_FOUND') {
        setTemplate({ id: templateId, name: templateId, modelOptions: [], serviceOptions: [] })
        setConfig(structuredClone(agent.config))
        setArchived(true)
      } else setLoadError(requestError.message)
    })
    return () => { active = false }
  }, [templateId, agent, domain.domain, retry])

  const field = (key, value) => setConfig(current => ({ ...current, [key]: value }))
  const capability = (group, key, value) => setConfig(current => ({ ...current, capabilities: {
    ...current.capabilities, [group]: { ...current.capabilities[group], [key]: value },
  } }))

  async function submit(event) {
    event.preventDefault()
    if (saving) return
    setError('')
    setSaving(true)
    try {
      const input = {
        domainName: domain.name, name: name.trim(),
        config: { ...config, questions: config.questions.map(value => value.trim()).filter(Boolean) },
        ...(agent ? { id: agent.id } : { templateId }),
      }
      const result = await graphqlRequest(agent ? UPDATE_AGENT_MUTATION : CREATE_AGENT_MUTATION, { input })
      onSaved(result[agent ? 'updateAgent' : 'createAgent'])
    } catch (requestError) {
      setError(requestError.message)
      setSaving(false)
    }
  }

  if (loadError) return <div className="alert alert-danger" role="alert">{loadError}
    <button className="btn btn-link" onClick={() => setRetry(value => value + 1)}>Retry</button>
    <button className="btn btn-link" onClick={onCancel}>Back</button>
  </div>
  if (!config || !template) return <p role="status">Loading template configuration…</p>

  const models = template.modelOptions
  const services = template.serviceOptions
  return <div className="row g-4">
    <div className="col-lg-8"><div className="card border-0 shadow-sm"><div className="card-body p-4">
      <h1 className="h4 fw-bold">{agent ? 'Edit agent' : `Configure ${template.name}`}</h1>
      <p className="text-muted">{domain.label} · {domain.domain}</p>
      {archived && <p className="alert alert-warning">The source template is no longer available. You can edit this agent’s saved configuration.</p>}
      <form onSubmit={submit}>
        {error && <div className="alert alert-danger" role="alert">{error}</div>}
        <fieldset disabled={saving}>
          <div className="mb-3"><label htmlFor="agent-name" className="form-label">Agent name</label>
            <input id="agent-name" className="form-control" value={name} onChange={event => setName(event.target.value)} maxLength={150} required />
          </div>
          <div className="mb-3"><label htmlFor="description" className="form-label">Description</label>
            <textarea id="description" className="form-control" value={config.description} onChange={event => field('description', event.target.value)} rows={3} maxLength={10000} required />
          </div>
          <div className="mb-3"><label htmlFor="instructions" className="form-label">Instructions</label>
            <textarea id="instructions" className="form-control" value={config.instructions} onChange={event => field('instructions', event.target.value)} rows={6} maxLength={10000} required />
          </div>
          <div className="row g-3 mb-3">
            <div className="col-md-6"><label htmlFor="model" className="form-label">Model</label>
              <select id="model" className="form-select" value={config.model} onChange={event => field('model', event.target.value)} required>
                {!models.some(item => item.id === config.model) && <option value={config.model}>{config.model} (saved selection)</option>}
                {models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            <div className="col-md-6"><label htmlFor="service" className="form-label">Primary external API</label>
              <select id="service" className="form-select" value={config.service} onChange={event => field('service', event.target.value)} required>
                {!services.some(item => item.id === config.service) && <option value={config.service}>{config.service} (saved selection)</option>}
                {services.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
          </div>
          <div className="mb-3"><label htmlFor="page" className="form-label">Page attachment</label>
            <input id="page" className="form-control" value={config.page} onChange={event => field('page', event.target.value)} maxLength={255} />
          </div>
          <fieldset className="border-top pt-3 mb-3"><legend className="h6 float-none w-auto">Attached external APIs</legend>
            {[...services, ...config.attached_services.filter(id => !services.some(item => item.id === id)).map(id => ({ id, name: `${id} (saved selection)` }))].map(item => <div className="form-check" key={item.id}>
              <input id={`api-${item.id}`} className="form-check-input" type="checkbox" checked={config.attached_services.includes(item.id)}
                onChange={event => field('attached_services', event.target.checked ? [...config.attached_services, item.id] : config.attached_services.filter(id => id !== item.id))} />
              <label htmlFor={`api-${item.id}`} className="form-check-label">{item.name}</label>
            </div>)}
          </fieldset>
          <fieldset className="border-top pt-3 mb-3"><legend className="h6 float-none w-auto">Starting questions</legend>
            {config.questions.map((question, index) => <div className="d-flex gap-2 mb-2" key={index}>
              <input aria-label={`Starting question ${index + 1}`} className="form-control" value={question} maxLength={1000}
                onChange={event => field('questions', config.questions.map((value, i) => i === index ? event.target.value : value))} />
              <button type="button" className="btn btn-outline-secondary" aria-label={`Remove question ${index + 1}`} onClick={() => field('questions', config.questions.filter((_, i) => i !== index))}>Remove</button>
            </div>)}
            <button type="button" className="btn btn-link ps-0" disabled={config.questions.length >= 50} onClick={() => field('questions', [...config.questions, ''])}>Add question</button>
          </fieldset>
          <fieldset className="border-top pt-3 mb-3"><legend className="h6 float-none w-auto">Alert configuration</legend>
            <div className="form-check mb-2"><input id="alerts-enabled" className="form-check-input" type="checkbox" checked={config.capabilities.alerts.enabled} onChange={event => capability('alerts', 'enabled', event.target.checked)} />
              <label htmlFor="alerts-enabled" className="form-check-label">Enable alerts</label></div>
            <label htmlFor="severity" className="form-label">Severity</label>
            <select id="severity" className="form-select" value={config.capabilities.alerts.severity} onChange={event => capability('alerts', 'severity', event.target.value)}>
              <option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
            </select>
          </fieldset>
          <fieldset className="border-top pt-3 mb-3"><legend className="h6 float-none w-auto">Webhook configuration</legend>
            <div className="form-check mb-2"><input id="webhooks-enabled" className="form-check-input" type="checkbox" checked={config.capabilities.webhooks.enabled} onChange={event => capability('webhooks', 'enabled', event.target.checked)} />
              <label htmlFor="webhooks-enabled" className="form-check-label">Enable webhook</label></div>
            <label htmlFor="webhook-url" className="form-label">HTTPS destination</label>
            <input id="webhook-url" className="form-control" type="url" pattern="https://.*" value={config.capabilities.webhooks.url} required={config.capabilities.webhooks.enabled}
              onChange={event => capability('webhooks', 'url', event.target.value)} placeholder="https://example.com/payroll-events" />
          </fieldset>
          <p className="small text-muted">Saving stores these settings. Agent execution and notification delivery are not active yet.</p>
          <div className="d-flex justify-content-end gap-2 mt-4">
            <button type="button" className="btn btn-outline-secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn-dark">{saving ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}</button>
          </div>
        </fieldset>
      </form>
    </div></div></div>
    <div className="col-lg-4"><div className="card border-0 shadow-sm"><div className="card-body">
      <div className="template-icon accent-neutral mb-3"><i className="bi bi-robot" /></div>
      <h2 className="h5">{name || template.name}</h2><p className="text-muted">{config.description}</p>
      <dl><dt>Domain</dt><dd>{domain.label}</dd><dt>Template</dt><dd>{templateId}</dd><dt>Version</dt><dd>{agent?.templateVersion || template.version}</dd></dl>
    </div></div></div>
  </div>
}
