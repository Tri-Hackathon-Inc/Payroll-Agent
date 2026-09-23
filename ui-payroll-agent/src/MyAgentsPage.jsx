function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5c.45 5.38 3.12 8.05 8.5 8.5-5.38.45-8.05 3.12-8.5 8.5-.45-5.38-3.12-8.05-8.5-8.5 5.38-.45 8.05-3.12 8.5-8.5Z" />
    </svg>
  )
}

const AGENT_TYPE_LABELS = {
  anomaly_detection: 'Anomaly Detection',
  summarizer: 'Summarizer',
  general_query: 'General Query',
  incident_generator: 'Incident Generator',
}

const DOMAIN_CLASS = {
  Payroll: 'domain-payroll',
  'Time off': 'domain-time-off',
  HR: 'domain-hr',
}

export default function MyAgentsPage({ agents, dataLoaded, error, onNewAgent, onOpenAgent, navigate }) {
  return (
    <div className="agents-page">
      <header className="agents-header">
        <div>
          <div className="eyebrow"><SparkleIcon /> My Agents</div>
          <h1>Available agents</h1>
          <p>Choose an agent to get help, or create one for a new workflow.</p>
        </div>
        <div className="agents-header-actions">
          <button
            type="button"
            className="secondary-button new-agent-button"
            onClick={() => navigate('/agents/templates')}
          >
            Browse Templates
          </button>
          <button
            type="button"
            className="primary-button new-agent-button"
            onClick={onNewAgent}
          >
            + Create agent
          </button>
        </div>
      </header>

      {error && <p className="error-banner" role="alert">{error}</p>}

      {dataLoaded && agents.length === 0 && !error && (
        <div className="agents-empty">
          <div className="agents-empty-icon"><SparkleIcon /></div>
          <h2>No agents yet</h2>
          <p>Start from a template to create your first agent in minutes.</p>
          <button type="button" className="primary-button" onClick={() => navigate('/agents/templates')}>
            Browse Templates <span>→</span>
          </button>
        </div>
      )}

      <section className="agent-grid" aria-label="Available agents">
        {agents.map((agent, index) => (
          <article className={`agent-card${index === 0 ? ' new-card' : ''}`} key={agent.id}>
            <div className="agent-card-top">
              <div className="agent-icon"><SparkleIcon /></div>
              <div className="agent-card-badges">
                {agent.agent_type && (
                  <span className={`agent-type-badge agent-type-${agent.agent_type}`}>
                    {AGENT_TYPE_LABELS[agent.agent_type] || agent.agent_type}
                  </span>
                )}
                <span className={`domain-badge ${DOMAIN_CLASS[agent.domain] || ''}`}>{agent.domain}</span>
              </div>
            </div>
            <h2>{agent.name}</h2>
            <p>{agent.description}</p>
            <button type="button" className="open-agent" onClick={() => onOpenAgent(agent)}>
              Open agent <span>→</span>
            </button>
          </article>
        ))}
      </section>
    </div>
  )
}
