// Model choice for an agent: one selectable card per model the template supports, with the
// published benchmark scores (each linked to its source) and our measured performance.

const LICENSE_BADGE = {
  'open-source': ['Open source', 'model-badge-oss'],
  commercial: ['Commercial', 'model-badge-commercial'],
  demo: ['Demo', 'text-bg-light border'],
}

// Scores are plain text so clicking anywhere on the card selects the model; the source is a
// separate small link.
export function Benchmarks({ benchmarks = [] }) {
  if (!benchmarks.length) return <span className="text-muted">No published score recorded</span>
  const sources = [...new Set(benchmarks.map(item => item.source))]
  return <span className="d-flex flex-wrap align-items-center gap-1">
    {benchmarks.map(item => <span key={item.name} className="badge model-strength-chip">{item.name} {item.score}</span>)}
    {sources.map(source => <a key={source} className="small ms-1" href={source} target="_blank" rel="noreferrer"
      title={source} onClick={event => event.stopPropagation()}>Source</a>)}
  </span>
}

export default function ModelPicker({ models, value, onChange }) {
  const options = models.some(item => item.id === value) ? models
    : [...models, { id: value, name: `${value} (saved selection)`, details: {} }]
  return <fieldset className="border-top pt-3 mb-3">
    <legend className="h6 float-none w-auto mb-1">Model</legend>
    <p className="small text-muted mb-2">{models.length} model{models.length === 1 ? '' : 's'} supported by this template. Scores are published benchmarks with their source.</p>
    <div className="row row-cols-1 row-cols-md-2 g-2" role="radiogroup" aria-label="Model">
      {options.map(model => {
        const details = model.details || {}
        const [license, badge] = LICENSE_BADGE[details.license] || []
        const checked = model.id === value
        return <div className="col" key={model.id}>
          <label className={`card h-100 model-option${checked ? ' model-option-selected' : ''}`}>
            <span className="card-body p-3 d-block">
              <span className="d-flex align-items-start gap-2 mb-1">
                <input className="form-check-input mt-1 flex-shrink-0" type="radio" name="model" value={model.id}
                  checked={checked} onChange={() => onChange(model.id)} />
                <span className="fw-semibold flex-grow-1">{model.name}</span>
                {license && <span className={`badge ${badge}`}>{license}</span>}
              </span>
              <span className="d-block small text-muted mb-2">{[details.vendor, details.context_window].filter(Boolean).join(' · ') || model.provider}</span>
              <span className="d-block small mb-1"><Benchmarks benchmarks={details.benchmarks} /></span>
              <span className="d-block small text-muted">Measured latency and tokens/s: not measured yet</span>
            </span>
          </label>
        </div>
      })}
    </div>
  </fieldset>
}
