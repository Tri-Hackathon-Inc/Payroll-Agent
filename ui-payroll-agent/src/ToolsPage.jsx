import { useEffect, useRef, useState } from 'react'

// Tools & APIs: the external APIs in the backend catalog (templates/services.json) that agents in
// the selected domain can attach, grouped by what they do and labelled by whether the runtime
// actually uses them today.

// How each catalog tool is used at runtime. The catalog only defines endpoints; this records which
// ones the backend actually calls (see backend/graphql/payrunContext.js and incidentReport.js).
// Update it when a tool is wired up. Tools not listed here are shown as catalog only.
const TOOL_INFO = {
  payrun: {
    icon: 'bi-cash-stack', group: 'data', status: 'live',
    description: 'The open payrun: its totals and every pay line.',
    via: 'TriNet payroll API (TRINET_API_URL) · payrun(id)',
  },
  'payrun-history': {
    icon: 'bi-clock-history', group: 'data', status: 'live',
    description: 'Completed payruns before the open one: the baseline for comparisons and anomaly checks.',
    via: 'TriNet payroll API · payrunHistory(before) · indexed for retrieval in pgvector',
  },
  'employee-details': {
    icon: 'bi-person-vcard', group: 'data', status: 'live',
    description: 'One employee’s pay lines, when the assistant is opened for that employee.',
    via: 'Payrun data scoped to context.employeeId',
  },
  diagnostics: {
    icon: 'bi-journal-code', group: 'data', status: 'catalog',
    description: 'Service logs for investigating failed payroll jobs.',
  },
  'email-notification': {
    icon: 'bi-envelope', group: 'action', status: 'configurable',
    description: 'Emails incident reports to INCIDENT_EMAIL_TO.',
    via: 'Sent by the Incident Report agent when EMAIL_API_BASE_URL is set; otherwise the report says it wasn’t sent.',
  },
  'slack-webhook': {
    icon: 'bi-slack', group: 'action', status: 'catalog',
    description: 'Posts payroll alerts to a Slack channel.',
  },
  'alert-manager': {
    icon: 'bi-bell', group: 'action', status: 'catalog',
    description: 'Pages the on-call team about critical findings.',
  },
  'opensearch-sink': {
    icon: 'bi-bar-chart-line', group: 'action', status: 'catalog',
    description: 'Records agent events for search and dashboards.',
  },
}

const GROUPS = [
  { key: 'data', title: 'Data sources', description: 'What agents read to answer questions and check payruns.' },
  { key: 'action', title: 'Actions', description: 'What agents can send or record when they find something.' },
]

const STATUS = {
  live: { label: 'Live', cls: 'tool-status-live', icon: 'bi-check-circle-fill' },
  configurable: { label: 'Live when configured', cls: 'tool-status-configurable', icon: 'bi-gear-fill' },
  catalog: { label: 'Catalog only', cls: 'tool-status-catalog', icon: 'bi-circle' },
}

// A tool the catalog adds later without an entry above: grouped by HTTP method, never claimed as live.
const toolInfo = (tool) => TOOL_INFO[tool.id]
  || { icon: 'bi-plug', group: tool.method === 'GET' ? 'data' : 'action', status: 'catalog', description: '' }

const usesTool = (config, id) => config?.service === id || (config?.attached_services || []).includes(id)

// Each distinct tool offered by the domain's templates, with the templates that use it by default:
// as their primary API (config.service) or as an attached tool (config.attached_services).
function collectTools(templates) {
  const tools = new Map()
  for (const template of templates) {
    for (const service of template.serviceOptions) {
      const tool = tools.get(service.id) || { ...service, primaryIn: [], attachedIn: [] }
      if (template.config.service === service.id) tool.primaryIn.push(template.name)
      else if ((template.config.attached_services || []).includes(service.id)) tool.attachedIn.push(template.name)
      tools.set(service.id, tool)
    }
  }
  return [...tools.values()]
}

function StatusBadge({ status }) {
  const item = STATUS[status]
  return <span className={`tool-status ${item.cls}`}><i className={`bi ${item.icon}`} aria-hidden="true" />{item.label}</span>
}

const agentsUsing = (agents, tool) => agents.filter((agent) => usesTool(agent.config, tool.id))
// Attached by some template but never called: worth flagging on both the card and the dialog.
const unusedAttachment = (tool) => toolInfo(tool).status === 'catalog' && tool.primaryIn.length + tool.attachedIn.length > 0

function usageSummary(tool) {
  if (tool.primaryIn.length) return `Primary API · ${tool.primaryIn.length} template${tool.primaryIn.length === 1 ? '' : 's'}`
  if (tool.attachedIn.length) return `Attached · ${tool.attachedIn.length} template${tool.attachedIn.length === 1 ? '' : 's'}`
  return 'Not used by default'
}

function ToolCard({ tool, onOpen }) {
  const info = toolInfo(tool)
  return <button type="button" className="card border-0 shadow-sm tool-card h-100 w-100 text-start" onClick={() => onOpen(tool)}
    aria-haspopup="dialog">
    <span className="card-body p-3 d-flex flex-column">
      <span className="d-flex align-items-start justify-content-between gap-2 mb-2">
        <span className="registry-icon flex-shrink-0"><i className={`bi ${info.icon}`} /></span>
        <StatusBadge status={info.status} />
      </span>
      <span className="h6 fw-bold mb-1 d-block">{tool.name}</span>
      {info.description && <span className="text-muted small tool-card-description">{info.description}</span>}
      <span className="tool-card-foot mt-auto pt-2">
        <span>{usageSummary(tool)}</span>
        {unusedAttachment(tool) && <i className="bi bi-exclamation-circle tool-card-flag" title="Attached by default, but no agent calls it yet." aria-label="Attached by default, but no agent calls it yet." />}
        <span className="ms-auto tool-card-more">Details <i className="bi bi-arrow-right" aria-hidden="true" /></span>
      </span>
    </span>
  </button>
}

// Native <dialog>: showModal() gives a backdrop, a focus trap, Esc to close, and returns focus
// to the card that opened it.
function ToolDialog({ tool, domain, agents, agentsLoading, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const dialog = ref.current
    if (tool && !dialog.open) dialog.showModal()
    if (!tool && dialog.open) dialog.close()
  }, [tool])

  const info = tool && toolInfo(tool)
  const using = tool ? agentsUsing(agents, tool) : []
  return <dialog ref={ref} className="tool-dialog" aria-labelledby="tool-dialog-title" onClose={onClose}
    onClick={(event) => { if (event.target === ref.current) ref.current.close() }}>
    {tool && <div className="tool-dialog-body">
      <div className="d-flex align-items-start gap-3 mb-3">
        <span className="registry-icon flex-shrink-0"><i className={`bi ${info.icon}`} /></span>
        <div className="flex-grow-1">
          <h3 id="tool-dialog-title" className="h5 fw-bold mb-1">{tool.name}</h3>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <StatusBadge status={info.status} />
            <span className="text-muted small">{info.group === 'data' ? 'Data source' : 'Action'}</span>
            {!tool.enabled && <span className="badge text-bg-secondary">Disabled in catalog</span>}
          </div>
        </div>
        <button type="button" className="btn-close" aria-label="Close" onClick={() => ref.current.close()} />
      </div>
      {info.description && <p className="mb-3">{info.description}</p>}
      {unusedAttachment(tool) && <p className="tool-warning mb-3"><i className="bi bi-info-circle me-1" aria-hidden="true" />Attached by default, but no agent calls it yet.</p>}

      <dl className="tool-dialog-facts">
        <dt>{info.via ? 'How agents reach it' : 'Planned endpoint'}</dt>
        <dd>{info.via || <code>{tool.method} {'{'}{tool.baseUrlEnv}{'}'}{tool.path}</code>}</dd>
        <dt>Primary API of</dt>
        <dd>{tool.primaryIn.length ? tool.primaryIn.join(', ') : <span className="text-muted">No template</span>}</dd>
        <dt>Attached in</dt>
        <dd>{tool.attachedIn.length ? tool.attachedIn.join(', ') : <span className="text-muted">No template</span>}</dd>
        <dt>Agents in {domain.label}</dt>
        <dd>{agentsLoading ? <span className="text-muted">Loading…</span>
          : using.length ? using.map((agent) => agent.name).join(', ')
          : <span className="text-muted">None yet</span>}</dd>
        <dt>Catalog entry</dt>
        {/* A catalog-only tool's endpoint is already shown above as its planned endpoint. */}
        <dd><code>{tool.id}</code>{info.via && <> · {tool.method} <code>{tool.path}</code> · host from <code>{tool.baseUrlEnv}</code></>}</dd>
      </dl>
    </div>}
  </dialog>
}

// templates: the studio's loaded templates (with serviceOptions); tools are those of the domain's category.
export default function ToolsPage({ domain, templates, agents, agentsLoading }) {
  const [openId, setOpenId] = useState(null)
  const tools = collectTools(templates.filter((template) => template.config.domain === domain.domain))
  const counts = Object.fromEntries(Object.keys(STATUS).map((key) => [key, tools.filter((tool) => toolInfo(tool).status === key).length]))
  const openTool = tools.find((tool) => tool.id === openId) || null

  return <>
    <div className="mb-4">
      <h2 className="h4 fw-bold mb-1">Tools &amp; APIs</h2>
      <p className="text-muted mb-2">The data sources and actions that agents in {domain.label} can use. Attach them when you configure an agent from a template. Select a tool for details.</p>
      <div className="d-flex flex-wrap gap-3 small" aria-label="Tool status summary">
        {Object.keys(STATUS).map((key) => counts[key] > 0 && <span key={key} className="d-inline-flex align-items-center gap-2">
          <StatusBadge status={key} /><span className="text-muted">{counts[key]}</span>
        </span>)}
      </div>
    </div>

    {!tools.length && <p className="text-muted">No tools are defined for the {domain.domain} domain yet.</p>}
    {GROUPS.map((group) => {
      const items = tools.filter((tool) => toolInfo(tool).group === group.key)
      if (!items.length) return null
      return <section className="mb-4" key={group.key} aria-labelledby={`tools-${group.key}`}>
        <h3 id={`tools-${group.key}`} className="h6 fw-bold mb-1">{group.title}</h3>
        <p className="text-muted small mb-2">{group.description}</p>
        <ul className="row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3 list-unstyled mb-0">
          {items.map((tool) => <li className="col" key={tool.id}><ToolCard tool={tool} onOpen={(item) => setOpenId(item.id)} /></li>)}
        </ul>
      </section>
    })}

    <div className="card border-0 shadow-sm">
      <div className="card-body">
        <h3 className="h6 fw-bold mb-2">How tools work</h3>
        <ul className="text-muted small mb-0 tool-notes">
          <li><strong>Attaching.</strong> An agent has one primary API and optional attached tools, saved as <code>service</code> and <code>attached_services</code>. The Agent Registry lists agents by their primary API.</li>
          <li><strong>Payroll data.</strong> Agents on the payrun page read the open payrun and its history from the TriNet payroll API. Completed payruns are also indexed in pgvector so answers can cite past runs.</li>
          <li><strong>Actions.</strong> Actions run only when a user asks, for example <em>Create incident report</em> in the Payroll Assistant. Agents don&apos;t send anything on their own.</li>
          <li><strong>Not enforced yet.</strong> Attached tools are recorded with the agent, but the runtime doesn&apos;t restrict an agent to them yet.</li>
        </ul>
      </div>
    </div>

    <ToolDialog tool={openTool} domain={domain} agents={agents} agentsLoading={agentsLoading} onClose={() => setOpenId(null)} />
  </>
}
