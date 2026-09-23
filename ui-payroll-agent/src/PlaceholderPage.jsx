const PAGE_META = {
  tools: {
    title: 'Tools & APIs',
    subtitle: 'Manage and browse approved payroll tools that agents can call at runtime.',
    items: [
      { name: 'Payroll API', desc: 'Access payroll records and calculations', badge: 'Connected' },
      { name: 'Historical Data', desc: 'Query historical payrun patterns for anomaly detection', badge: 'Connected' },
      { name: 'Alert API', desc: 'Emit and route anomaly alerts to payroll teams', badge: 'Connected' },
      { name: 'PEO API', desc: 'Update employee master data and maintain history', badge: 'Pending' },
      { name: 'Rules Engine', desc: 'Validate pay data against payroll business rules', badge: 'Pending' },
      { name: 'Validation Service', desc: 'Cross-check pay data for compliance requirements', badge: 'Pending' },
    ],
  },
  models: {
    title: 'Models',
    subtitle: 'Browse and configure approved language models available for agent creation.',
    items: [
      { name: 'Claude Sonnet 4.6', desc: 'Balanced performance — recommended for most payroll agents', badge: 'Available' },
      { name: 'Claude Haiku 4.5', desc: 'Fastest response time, ideal for real-time anomaly detection', badge: 'Available' },
      { name: 'Llama 3.3 70B', desc: 'Open-source model for on-premise or air-gapped deployments', badge: 'Available' },
      { name: 'Mistral Large', desc: 'Strong reasoning for complex query and summarization tasks', badge: 'Available' },
    ],
  },
  registry: {
    title: 'Agent Registry',
    subtitle: 'All agents created across services, discoverable by domain and service.',
    items: [
      { name: 'Anomaly_Detection_Payrun_Agent', desc: 'Service: Payrun · Domain: Payroll · Runtime: Real-time', badge: 'Active' },
      { name: 'Payrun_Summarizer_Agent', desc: 'Service: Payrun · Domain: Payroll · Runtime: Offline', badge: 'Active' },
      { name: 'Payrun_General_Query_Agent', desc: 'Service: Payrun · Domain: Payroll · Runtime: Interactive', badge: 'Active' },
    ],
  },
  evaluation: {
    title: 'Evaluation',
    subtitle: 'Run evals, review agent performance, and track accuracy over time.',
    items: [
      { name: 'Anomaly Detection — Precision', desc: 'True positive rate across last 500 payrun entries', badge: '94.2%' },
      { name: 'Summarizer — Accuracy', desc: 'User satisfaction score on generated summaries', badge: '4.7 / 5' },
      { name: 'General Query — Relevance', desc: 'Answer relevance rating from payroll team feedback', badge: '88.1%' },
    ],
  },
}

export default function PlaceholderPage({ page }) {
  const meta = PAGE_META[page] || { title: page, subtitle: '', items: [] }

  return (
    <div className="placeholder-page">
      <header className="templates-header">
        <p className="page-eyebrow">Agent Studio</p>
        <h1>{meta.title}</h1>
        <p className="templates-subtitle">{meta.subtitle}</p>
      </header>

      <div className="coming-soon-banner">
        <span className="coming-soon-pill">Coming soon</span>
        <p>This section is in progress. The items below reflect the planned catalogue.</p>
      </div>

      <div className="placeholder-list">
        {meta.items.map((item) => (
          <div key={item.name} className="placeholder-item">
            <div className="placeholder-item-body">
              <strong>{item.name}</strong>
              <span>{item.desc}</span>
            </div>
            <span className={`placeholder-badge placeholder-badge-${item.badge.toLowerCase().replace(/[^a-z]/g, '')}`}>
              {item.badge}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
