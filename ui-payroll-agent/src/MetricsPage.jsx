import { useEffect, useState } from 'react'
import { graphqlRequest } from './graphql/client'
import { AGENT_METRICS_QUERY } from './graphql/operations'
import { trinetUrl } from './links'

// Admin view of how agents are used and how well they answer, measured from every answer the
// agents gave (recorded by the chat webhook; benchmark runs are excluded). Nothing is estimated.
const RANGES = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 24 * 7, label: 'Last 7 days' },
  { hours: 24 * 30, label: 'Last 30 days' },
  { hours: 0, label: 'All time' },
]
const ANSWER_TYPES = {
  'payroll-data': { label: 'Computed from payroll data', icon: 'bi-calculator' },
  model: { label: 'Written by a model', icon: 'bi-cpu' },
  rag: { label: 'Payroll history search (RAG)', icon: 'bi-search' },
  'anomaly-pipeline': { label: 'Anomaly pipeline', icon: 'bi-activity' },
  'incident-report': { label: 'Incident report', icon: 'bi-file-earmark-medical' },
  acknowledged: { label: 'Acknowledged (no model connected)', icon: 'bi-chat-left' },
  error: { label: 'Error', icon: 'bi-exclamation-triangle' },
}

const pct = value => (value == null ? '—' : `${Math.round(value * 100)}%`)
const duration = ms => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
const dollars = value => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const number = value => Number(value || 0).toLocaleString('en-US')
const typeLabel = type => ANSWER_TYPES[type]?.label || type
const plural = (count, word) => `${number(count)} ${word}${count === 1 ? '' : 's'}`

function Kpi({ label, value, detail, icon }) {
  return <div className="col">
    <div className="card border-0 shadow-sm h-100 metrics-kpi">
      <div className="card-body">
        <div className="small text-muted d-flex align-items-center gap-2"><i className={`bi ${icon}`} aria-hidden="true" />{label}</div>
        <div className="metrics-kpi-value">{value}</div>
        {detail && <div className="small text-muted">{detail}</div>}
      </div>
    </div>
  </div>
}

function Section({ title, subtitle, children }) {
  return <section className="mb-4">
    <h3 className="h6 fw-bold mb-1">{title}</h3>
    {subtitle && <p className="small text-muted mb-2">{subtitle}</p>}
    {children}
  </section>
}

function Bars({ rows, value, label, detail }) {
  const max = Math.max(1, ...rows.map(value))
  return <ul className="list-unstyled mb-0 metrics-bars">
    {rows.map((row, index) => <li key={index}>
      <div className="d-flex justify-content-between small"><span>{label(row)}</span><span className="text-muted">{detail(row)}</span></div>
      <div className="metrics-bar" role="presentation"><span style={{ width: `${(value(row) / max) * 100}%` }} /></div>
    </li>)}
  </ul>
}

export default function MetricsPage({ domain, agents, agentsLoading }) {
  const [hours, setHours] = useState(24 * 7)
  const [agentId, setAgentId] = useState('')
  const [reload, setReload] = useState(0)
  const [result, setResult] = useState(null)

  useEffect(() => {
    let active = true
    setResult(current => (current ? { ...current, loading: true } : null))
    graphqlRequest(AGENT_METRICS_QUERY, { domainName: domain.name, agentId: agentId || null, sinceHours: hours })
      .then(data => { if (active) setResult({ metrics: data.agentMetrics, error: '' }) })
      .catch(error => { if (active) setResult({ metrics: null, error: error.message }) })
    return () => { active = false }
  }, [domain.name, agentId, hours, reload])

  const metrics = result?.metrics
  const summary = metrics?.summary
  const business = metrics?.business
  const quality = metrics?.quality

  return <div>
    <div className="d-flex flex-wrap align-items-end justify-content-between gap-3 mb-3">
      <div>
        <h2 className="h5 fw-bold mb-1">Agent Metrics</h2>
        <p className="text-muted small mb-0">Measured from every answer {domain.label} agents gave. Benchmark runs are excluded.</p>
      </div>
      <div className="d-flex flex-wrap gap-2 align-items-center">
        <select className="form-select form-select-sm w-auto" aria-label="Agent" value={agentId} onChange={event => setAgentId(event.target.value)} disabled={agentsLoading}>
          <option value="">All agents</option>
          {(agents || []).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
        <select className="form-select form-select-sm w-auto" aria-label="Time range" value={hours} onChange={event => setHours(Number(event.target.value))}>
          {RANGES.map(range => <option key={range.hours} value={range.hours}>{range.label}</option>)}
        </select>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setReload(value => value + 1)} disabled={result?.loading}>
          <i className="bi bi-arrow-clockwise me-1" aria-hidden="true" />Refresh
        </button>
      </div>
    </div>

    {!result && <p className="text-muted"><span className="spinner-border spinner-border-sm me-2" />Loading metrics…</p>}
    {result?.error && <div className="alert alert-danger" role="alert">Could not load metrics: {result.error}</div>}
    {summary && summary.questions === 0 && <div className="card border-0 shadow-sm"><div className="card-body text-center py-5">
      <i className="bi bi-bar-chart fs-2 text-muted" aria-hidden="true" />
      <p className="fw-semibold mt-2 mb-1">No answers recorded in this period</p>
      <p className="text-muted small mb-3">Metrics appear as soon as someone asks an agent a question on the payrun page.</p>
      <a className="btn btn-dark btn-sm" href={trinetUrl(domain.name)} target="_blank" rel="noreferrer">Open the payrun page <i className="bi bi-box-arrow-up-right ms-1" /></a>
    </div></div>}

    {summary && summary.questions > 0 && <>
      <Section title="Business impact" subtitle="What the agents surfaced for payroll reviewers. Findings and dollars at risk count each payrun once.">
        <div className="row row-cols-2 row-cols-lg-3 row-cols-xxl-6 g-3">
          <Kpi icon="bi-chat-dots" label="Questions answered" value={number(summary.questions)} detail={`${plural(summary.conversations, 'conversation')} · ${plural(summary.activeAgents, 'agent')}`} />
          <Kpi icon="bi-file-earmark-spreadsheet" label="Payruns reviewed" value={number(summary.payrunsReviewed)} />
          <Kpi icon="bi-flag" label="Findings surfaced" value={number(business.findings.critical + business.findings.warning + business.findings.info)}
            detail={<><span className="metrics-sev critical">{business.findings.critical} critical</span> <span className="metrics-sev warning">{business.findings.warning} warning</span> <span className="metrics-sev info">{business.findings.info} info</span></>} />
          <Kpi icon="bi-currency-dollar" label="Dollars at risk flagged" value={dollars(business.amountAtRisk)} />
          <Kpi icon="bi-file-earmark-medical" label="Incidents raised" value={number(business.incidentsRaised)}
            detail={`${number(business.realtimeIncidents || 0)} from automatic checks (${plural(business.realtimeChecks || 0, 'payroll change')}) · ${plural(business.manualIncidents, 'manual handoff')} · ${plural(business.warningsSuggested, 'warning')} suggested`} />
          <Kpi icon="bi-hand-thumbs-up" label="Helpful rate" value={pct(summary.helpfulRate)} detail={`${number(summary.up)} 👍 · ${number(summary.down)} 👎`} />
        </div>
      </Section>

      <Section title="Agent performance" subtitle="How answers were produced and how reliable they were.">
        <div className="row row-cols-2 row-cols-lg-3 row-cols-xxl-5 g-3">
          <Kpi icon="bi-calculator" label="Answered from data" value={pct(summary.dataShare)} detail={`${plural(summary.answeredFromData, 'exact answer')}, no model call`} />
          <Kpi icon="bi-stopwatch" label="Response time" value={duration(summary.avgLatencyMs)} detail={`p95 ${duration(summary.p95LatencyMs)} · full request, incl. automatic incidents`} />
          <Kpi icon="bi-shield-check" label="Reply check pass rate" value={pct(quality.checkPassRate)} detail={`${number(quality.flagged)} of ${number(quality.checked)} model answers flagged`} />
          <Kpi icon="bi-lightning" label="Cache hit rate" value={pct(quality.cacheHitRate)} detail={`${number(quality.cached)} of ${number(quality.modelAnswers)} model answers`} />
          <Kpi icon="bi-exclamation-triangle" label="Errors" value={number(summary.errors)} detail={quality.errorReasons[0]?.reason || 'None'} />
        </div>
      </Section>

      <div className="row g-4">
        <div className="col-lg-6">
          <Section title="How questions were answered">
            <div className="card border-0 shadow-sm"><div className="card-body">
              <Bars rows={metrics.answerTypes} value={row => row.count}
                label={row => <><i className={`bi ${ANSWER_TYPES[row.type]?.icon || 'bi-dot'} me-1`} aria-hidden="true" />{typeLabel(row.type)}</>}
                detail={row => `${number(row.count)} · avg ${duration(row.avgLatencyMs)}`} />
            </div></div>
          </Section>
        </div>
        <div className="col-lg-6">
          <Section title="Activity">
            <div className="card border-0 shadow-sm"><div className="card-body">
              <div className="metrics-timeline" role="img" aria-label={`Questions per ${hours && hours <= 48 ? 'hour' : 'day'}`}>
                {metrics.timeline.map(point => {
                  const max = Math.max(1, ...metrics.timeline.map(item => item.questions))
                  return <div key={point.bucket} className="metrics-timeline-bar" title={`${point.bucket}: ${point.questions} questions${point.errors ? `, ${point.errors} errors` : ''}`}>
                    <span style={{ height: `${(point.questions / max) * 100}%` }} className={point.errors ? 'has-errors' : ''} />
                  </div>
                })}
              </div>
              <div className="d-flex justify-content-between small text-muted mt-1">
                <span>{metrics.timeline[0]?.bucket}</span><span>{metrics.timeline.at(-1)?.bucket}</span>
              </div>
            </div></div>
          </Section>
        </div>
      </div>

      <Section title="Agents">
        <div className="card border-0 shadow-sm"><div className="table-responsive">
          <table className="table table-sm align-middle mb-0 metrics-table">
            <thead><tr><th>Agent</th><th className="text-end">Questions</th><th className="text-end">From data</th><th className="text-end">Avg / p95</th>
              <th className="text-end">Helpful</th><th className="text-end">Flagged</th><th className="text-end">Incidents</th><th className="text-end">Errors</th></tr></thead>
            <tbody>{metrics.agents.map(agent => <tr key={agent.agentId}>
              <td><div className="fw-semibold">{agent.name}</div><div className="small text-muted">{agent.templateId}</div></td>
              <td className="text-end">{number(agent.questions)}</td>
              <td className="text-end">{pct(agent.dataShare)}</td>
              <td className="text-end">{duration(agent.avgLatencyMs)} / {duration(agent.p95LatencyMs)}</td>
              <td className="text-end">{pct(agent.helpfulRate)} <span className="small text-muted">({agent.up}/{agent.up + agent.down})</span></td>
              <td className="text-end">{number(agent.flagged)}</td>
              <td className="text-end">{number(agent.incidents)}</td>
              <td className="text-end">{number(agent.errors)}</td>
            </tr>)}</tbody>
          </table>
        </div></div>
      </Section>

      <div className="row g-4">
        <div className="col-lg-7">
          <Section title="Models" subtitle="Model calls only; answers computed from data use no model.">
            <div className="card border-0 shadow-sm"><div className="table-responsive">
              {metrics.models.length ? <table className="table table-sm align-middle mb-0 metrics-table">
                <thead><tr><th>Model</th><th className="text-end">Calls</th><th className="text-end">Avg / p95</th><th className="text-end">Tokens in / out</th><th className="text-end">Errors</th></tr></thead>
                <tbody>{metrics.models.map(model => <tr key={model.modelId}>
                  <td className="fw-semibold">{model.modelId}</td>
                  <td className="text-end">{number(model.calls)}</td>
                  <td className="text-end">{duration(model.avgLatencyMs)} / {duration(model.p95LatencyMs)}</td>
                  <td className="text-end">{number(model.promptTokens)} / {number(model.completionTokens)}</td>
                  <td className="text-end">{number(model.errors)}</td>
                </tr>)}</tbody>
              </table> : <p className="small text-muted p-3 mb-0">No model calls in this period.</p>}
            </div></div>
          </Section>
        </div>
        <div className="col-lg-5">
          <Section title="Most asked">
            <div className="card border-0 shadow-sm"><div className="card-body">
              <Bars rows={business.topQuestions} value={row => row.count} label={row => <span className="text-truncate d-inline-block metrics-question">{row.question}</span>}
                detail={row => number(row.count)} />
            </div></div>
          </Section>
        </div>
      </div>

      <Section title="Recent answers">
        <div className="card border-0 shadow-sm"><div className="table-responsive">
          <table className="table table-sm align-middle mb-0 metrics-table">
            <thead><tr><th>Time</th><th>Agent</th><th>Question</th><th>Answered by</th><th className="text-end">Latency</th><th>Check</th><th>Feedback</th></tr></thead>
            <tbody>{metrics.recent.map(item => <tr key={item.id}>
              <td className="small text-nowrap">{new Date(item.createdAt).toLocaleString()}</td>
              <td className="small">{item.agentName}</td>
              <td className="small"><span className="d-inline-block text-truncate metrics-question" title={item.question}>{item.question}</span>
                {item.error && <div className="small text-danger text-truncate metrics-question" title={item.error}>{item.error}</div>}</td>
              <td className="small">{typeLabel(item.answeredBy)}{item.modelId && item.answeredBy !== 'payroll-data' ? <div className="text-muted">{item.modelId}</div> : null}</td>
              <td className="small text-end">{duration(item.latencyMs)}</td>
              <td className="small">{item.checkStatus === 'flagged' ? <span className="text-danger">Flagged</span> : item.checkStatus === 'passed' ? <span className="text-success">Passed</span> : '—'}</td>
              <td className="small">{item.feedback === 'up' ? '👍' : item.feedback === 'down' ? '👎' : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div></div>
      </Section>
    </>}
  </div>
}
