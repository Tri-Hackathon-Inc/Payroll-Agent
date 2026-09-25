import { useState } from 'react'
import { callWebhook } from './agentWebhook'
import { EVALUATION_PAYRUN, EVALUATION_SUITES, gradeReply } from './evaluationSuites'

const checkCount = (suite) => suite.cases.reduce((total, item) => total + item.checks.length, 0)

function ScoreBadge({ result }) {
  if (!result) return <span className="text-muted small">Not run</span>
  if (result.running) return <span className="text-muted small"><span className="spinner-border spinner-border-sm me-1" />Running…</span>
  if (result.error) return <span className="badge text-bg-danger">Error</span>
  const passed = result.cases.flatMap((item) => item.checks).filter((check) => check.passed).length
  const total = result.cases.reduce((sum, item) => sum + item.checks.length, 0)
  const pct = Math.round((passed / total) * 100)
  return <span className={`badge ${pct >= 80 ? 'eval-score-good' : pct >= 50 ? 'eval-score-fair' : 'eval-score-poor'}`}>{passed}/{total} · {pct}%</span>
}

function ResultDetail({ result }) {
  if (result.error) return <p className="text-danger small mb-0"><i className="bi bi-exclamation-circle me-1" />{result.error}</p>
  return result.cases.map((item) => (
    <div key={item.id} className="mb-3">
      <div className="small fw-semibold mb-1"><i className="bi bi-chat-left-text me-1" />{item.prompt}</div>
      <div className="eval-reply small mb-2">{item.reply}</div>
      <ul className="list-unstyled small mb-0">
        {item.checks.map((check) => (
          <li key={check.label} className={check.passed ? 'text-success' : 'text-danger'}>
            <i className={`bi ${check.passed ? 'bi-check-circle' : 'bi-x-circle'} me-1`} />{check.label}
          </li>
        ))}
      </ul>
    </div>
  ))
}

export default function EvaluationPage({ domain, agents, agentsLoading, onBrowseTemplates }) {
  const [results, setResults] = useState({})
  const [open, setOpen] = useState('')

  async function run(agent) {
    const suite = EVALUATION_SUITES[agent.templateId]
    setResults((current) => ({ ...current, [agent.id]: { running: true } }))
    setOpen(agent.id)
    try {
      const cases = []
      for (const item of suite.cases) {
        const { reply } = await callWebhook({
          domain, agent, question: item.prompt, source: 'agent-studio-evaluation',
          context: { page: 'payrun', payrunId: EVALUATION_PAYRUN, evaluation: item.id },
        })
        cases.push({ id: item.id, prompt: item.prompt, reply, checks: gradeReply(reply, item.checks) })
      }
      setResults((current) => ({ ...current, [agent.id]: { cases, ranAt: new Date() } }))
    } catch (error) {
      setResults((current) => ({ ...current, [agent.id]: { error: error.message || 'The agent webhook could not be reached.' } }))
    }
  }

  return <>
    <div className="mb-4">
      <h1 className="h4 fw-bold mb-1">Evaluation</h1>
      <p className="text-muted mb-0">Score agents against golden test cases from the sample TriNet payrun {EVALUATION_PAYRUN} before attaching them to a payroll page.</p>
    </div>

    <div className="alert alert-warning d-flex align-items-start gap-2 small" role="note">
      <i className="bi bi-info-circle mt-1" />
      <span>Runs send real requests to each agent&apos;s webhook and grade the replies. Agent execution is not active yet, so the stub reply contains no findings and most checks will fail until execution is enabled.</span>
    </div>

    <h2 className="h6 fw-bold mb-3">Test suites</h2>
    <div className="row row-cols-1 row-cols-md-3 g-3 mb-4">
      {Object.entries(EVALUATION_SUITES).map(([templateId, suite]) => (
        <div className="col" key={templateId}>
          <div className="card h-100 border-0 shadow-sm"><div className="card-body">
            <div className="d-flex align-items-center gap-2 mb-2"><i className="bi bi-clipboard-check text-primary" /><span className="fw-semibold">{suite.name}</span></div>
            <p className="text-muted small mb-2">{suite.description}</p>
            <div className="d-flex flex-wrap gap-1">
              <span className="badge text-bg-light border">{templateId}</span>
              <span className="badge text-bg-light border">{suite.cases.length} {suite.cases.length === 1 ? 'prompt' : 'prompts'}</span>
              <span className="badge text-bg-light border">{checkCount(suite)} checks</span>
            </div>
          </div></div>
        </div>
      ))}
    </div>

    <h2 className="h6 fw-bold mb-3">Agents in {domain.label}</h2>
    <div className="card border-0 shadow-sm">
      {agentsLoading ? <div className="p-4"><p role="status" className="text-muted mb-0"><span className="spinner-border spinner-border-sm me-2" />Loading agents…</p></div>
        : !agents.length ? <div className="p-4 text-center">
          <p className="text-muted small mb-3">No agents to evaluate yet. Create one from a template first.</p>
          <button type="button" className="btn btn-dark btn-sm" onClick={onBrowseTemplates}>Browse templates <i className="bi bi-arrow-right" /></button>
        </div>
        : <ul className="list-group list-group-flush rounded">
          {agents.map((agent) => {
            const suite = EVALUATION_SUITES[agent.templateId]
            const result = results[agent.id]
            return <li className="list-group-item px-4 py-3" key={agent.id}>
              <div className="d-flex align-items-center gap-3 flex-wrap">
                <span className="registry-icon flex-shrink-0"><i className="bi bi-stars" /></span>
                <div className="flex-grow-1" style={{ minWidth: 0 }}>
                  <div className="fw-semibold">{agent.name}</div>
                  <div className="text-muted small">{suite ? `${suite.name} · ${checkCount(suite)} checks` : `No test suite for the ${agent.templateId} template yet`}</div>
                </div>
                <ScoreBadge result={result} />
                {result && !result.running && <button type="button" className="btn btn-link btn-sm" onClick={() => setOpen(open === agent.id ? '' : agent.id)}>{open === agent.id ? 'Hide' : 'Details'}</button>}
                <button type="button" className="btn btn-outline-secondary btn-sm" disabled={!suite || result?.running} onClick={() => run(agent)}>
                  <i className="bi bi-play-fill me-1" />{result && !result.running ? 'Re-run' : 'Run'}
                </button>
              </div>
              {open === agent.id && result && !result.running && <div className="eval-detail mt-3"><ResultDetail result={result} /></div>}
            </li>
          })}
        </ul>}
    </div>
  </>
}
