import { useMemo, useState } from 'react'
import { Benchmarks } from './ModelPicker'

// Model library: the enabled models from the backend catalog (templates/Model_config), with an
// open-source / commercial filter. Templates offer these models when configuring an agent.

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open-source', label: 'Open source' },
  { key: 'commercial', label: 'Commercial' },
]
const LICENSE_STYLE = {
  'open-source': { label: 'Open source', badge: 'model-badge-oss', accent: 'accent-green' },
  commercial: { label: 'Commercial', badge: 'model-badge-commercial', accent: 'accent-purple' },
  demo: { label: 'Demo', badge: 'text-bg-light border', accent: 'accent-neutral' },
}

// Each distinct model offered by any template, with the templates that offer it.
function collectModels(templates) {
  const models = new Map()
  for (const template of templates) {
    for (const model of template.modelOptions) {
      const entry = models.get(model.id) || { ...model, templates: [] }
      entry.templates.push(template.name)
      models.set(model.id, entry)
    }
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// templates: the studio's loaded templates (with modelOptions); null while they load.
export default function ModelsPage({ templates }) {
  const models = useMemo(() => templates && collectModels(templates), [templates])
  const [filter, setFilter] = useState('all')

  const count = key => (models || []).filter(model => key === 'all' || model.details.license === key).length
  const visible = (models || []).filter(model => filter === 'all' || model.details.license === filter)

  return <>
    <div className="d-flex flex-wrap align-items-end justify-content-between gap-3 mb-3">
      <div>
        <h2 className="h4 fw-bold mb-1">Model Library</h2>
        <p className="text-muted mb-0">Models agents can use. Pick one per agent when configuring a template.</p>
      </div>
      <div className="btn-group btn-group-sm" role="group" aria-label="Filter models">
        {FILTERS.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key}
          className={`btn ${filter === item.key ? 'btn-dark' : 'btn-outline-secondary'}`} onClick={() => setFilter(item.key)}>
          {item.label} <span className="opacity-75">{models ? count(item.key) : ''}</span>
        </button>)}
      </div>
    </div>

    {!models ? <p role="status" className="text-muted"><span className="spinner-border spinner-border-sm me-2" />Loading models…</p>
      : <div className="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3">
        {visible.map(model => {
          const license = LICENSE_STYLE[model.details.license] || LICENSE_STYLE.demo
          return <div className="col" key={model.id}>
            <div className={`card h-100 border-0 shadow-sm model-card model-card-compact ${license.accent}`}>
              <div className="card-body p-3 d-flex flex-column">
                <div className="d-flex align-items-start justify-content-between gap-2 mb-1">
                  <h3 className="h6 fw-bold mb-0">{model.name}</h3>
                  <span className={`badge ${license.badge}`}>{license.label}</span>
                </div>
                <div className="text-muted small mb-2">{model.details.vendor || model.provider}{model.details.context_window && <> · {model.details.context_window}</>}</div>
                {model.details.description && <p className="text-muted small mb-2 model-description">{model.details.description}</p>}
                <div className="small mb-2"><Benchmarks benchmarks={model.details.benchmarks} /></div>
                {!!model.details.strengths?.length && <div className="d-flex flex-wrap gap-1 mb-2">
                  {model.details.strengths.map(item => <span key={item} className="badge model-strength-chip">{item}</span>)}
                </div>}
                <div className="mt-auto pt-2 border-top small text-muted d-flex flex-wrap justify-content-between gap-2">
                  <code className="text-truncate" title={model.modelId}>{model.modelId}</code>
                  <span>{model.templates.length} template{model.templates.length === 1 ? '' : 's'}</span>
                </div>
              </div>
            </div>
          </div>
        })}
      </div>}
    {models && !visible.length && <p>No models match this filter.</p>}
  </>
}
