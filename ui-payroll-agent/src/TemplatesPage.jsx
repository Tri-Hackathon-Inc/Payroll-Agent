export const TEMPLATES = [
  {
    id: 'anomaly_detection',
    agentType: 'anomaly_detection',
    name: 'Anomaly Detection',
    runtime: 'REAL-TIME',
    runtimeKey: 'real-time',
    bullets: ['Streaming / event input', 'History + rules utilities', 'Detect · score · alert'],
    defaultInstructions:
      'Monitor incoming payrun data in real time. Compare each entry against historical patterns. Flag anomalies with a severity score. Raise alerts for high-severity deviations before they propagate.',
    defaultTools: ['historical_data', 'alert_api', 'rules_engine'],
  },
  {
    id: 'summarizer',
    agentType: 'summarizer',
    name: 'Summarizer',
    runtime: 'OFFLINE',
    runtimeKey: 'offline',
    bullets: ['On-demand / scheduled', 'Context retrieval utilities', 'Summarize · structure'],
    defaultInstructions:
      'Fetch employee-level payrun details from backend services. Produce a structured summary including totals, changes, new hires, and terminations for UI rendering.',
    defaultTools: ['payroll_api', 'peo_api'],
  },
  {
    id: 'general_query',
    agentType: 'general_query',
    name: 'General Query',
    runtime: 'INTERACTIVE',
    runtimeKey: 'interactive',
    bullets: ['Question + context', 'Tool-calling pattern', 'Reason · answer'],
    defaultInstructions:
      'Answer contextual questions about the current payrun using attached payroll tools. Be precise, cite data sources, and stay within the scope of approved payroll information.',
    defaultTools: ['payroll_api', 'historical_data', 'validation_service'],
  },
  {
    id: 'incident_generator',
    agentType: 'incident_generator',
    name: 'Incident Generator',
    runtime: 'EVENT-DRIVEN',
    runtimeKey: 'event-driven',
    bullets: ['Failure / alert signal', 'Evidence utilities', 'Create · enrich · route'],
    defaultInstructions:
      'Detect failures or reported issues. Reproduce the scenario in a test environment. Capture screenshots and logs. Create a structured incident with expected vs actual results and route it to the responsible engineering team.',
    defaultTools: ['payroll_api', 'alert_api', 'validation_service'],
  },
]

function TemplateIcon({ type }) {
  if (type === 'anomaly_detection') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    )
  }
  if (type === 'summarizer') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
      </svg>
    )
  }
  if (type === 'general_query') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

export default function TemplatesPage({ navigate }) {
  return (
    <div className="templates-page">
      <header className="templates-header">
        <div>
          <p className="page-eyebrow">Agent Studio</p>
          <h1>Create Agent from Template</h1>
          <p className="templates-subtitle">
            Choose a template that matches the runtime behaviour you need. Templates provide out-of-the-box capabilities — you configure the domain, tools, and instructions.
          </p>
        </div>
      </header>

      <div className="template-grid">
        {TEMPLATES.map((tpl) => (
          <article key={tpl.id} className={`template-card template-card-${tpl.runtimeKey}`}>
            <div className="template-card-top">
              <div className={`template-icon template-icon-${tpl.runtimeKey}`}>
                <TemplateIcon type={tpl.id} />
              </div>
              <span className={`runtime-badge runtime-${tpl.runtimeKey}`}>{tpl.runtime}</span>
            </div>

            <h2 className="template-name">{tpl.name}</h2>

            <ul className="template-bullets">
              {tpl.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>

            <button
              type="button"
              className="primary-button use-template-btn"
              onClick={() => navigate(`/agents/new?template=${tpl.id}`)}
            >
              Use Template <span>→</span>
            </button>
          </article>
        ))}
      </div>

      <section className="templates-info">
        <div className="templates-info-item">
          <strong>Reusable capabilities out of the box</strong>
          <p>Templates include default instructions, model configuration, suggested tools, and base guardrails.</p>
        </div>
        <div className="templates-info-item">
          <strong>Configure for your domain</strong>
          <p>Add domain-specific tools, payroll APIs, custom instructions, and role-based access after selecting a template.</p>
        </div>
        <div className="templates-info-item">
          <strong>Discover &amp; connect</strong>
          <p>Published agents are discoverable by payroll services via <code>GET /&#123;service&#125;/list-agents</code> and invoked through a common runtime API.</p>
        </div>
      </section>
    </div>
  )
}
