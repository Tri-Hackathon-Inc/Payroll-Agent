import { useState } from 'react'
import { STATUS, money, shortDay, usDate } from './format'

export function StatusDot({ status }) {
  return <span className={`tn-status tn-status-${status.toLowerCase()}`}><span className="tn-dot" />{STATUS[status] || status}</span>
}

const FILTERS = [['', 'All payrolls'], ['PENDING_APPROVAL', 'Draft'], ['COMPLETED', 'Completed']]

export default function PayrollList({ payruns, onOpen }) {
  const [filter, setFilter] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const visible = payruns.filter((run) => !filter || run.status === filter)
  return <div className="tn-page">
    <nav className="tn-breadcrumb"><span>All Actions</span><i className="bi bi-chevron-right" /><span>Payrolls</span></nav>
    <div className="d-flex align-items-center justify-content-between mb-4">
      <h1 className="tn-title mb-0">Payrolls</h1>
      <button type="button" className="tn-btn-primary" disabled title="Not available in the mock">Add Off-Cycle</button>
    </div>
    <section className="tn-card p-4">
      <div className="d-flex align-items-center justify-content-between mb-4 position-relative">
        <h2 className="tn-subtitle mb-0">Payrolls</h2>
        <button type="button" className="tn-btn-muted" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}><i className="bi bi-funnel me-2" />Filters</button>
        {filtersOpen && <div className="tn-filter-menu">
          {FILTERS.map(([value, label]) => (
            <button type="button" key={label} className={filter === value ? 'active' : ''} onClick={() => { setFilter(value); setFiltersOpen(false) }}>{label}</button>
          ))}
        </div>}
      </div>
      {!visible.length ? <div className="tn-empty">
        <i className="bi bi-calendar4" />
        <h3>No Payrolls yet</h3>
        <p>View and manage payrolls, including regular payrolls, off-cycle payrolls, final pay, corrections, bonuses, and other employee payments.</p>
      </div> : <div className="d-flex flex-column gap-3">
        {visible.map((run) => (
          <article className="tn-payroll-card" key={run.id}>
            <div>
              <button type="button" className="tn-link tn-payroll-name" onClick={() => onOpen(run.id)}>Payroll for {shortDay(run.periodStart)} - {shortDay(run.periodEnd)}</button>
              <div className="tn-meta">Approve by: {usDate(run.payDate)}<span className="tn-sep">•</span>Pay Date: {usDate(run.payDate)}<span className="tn-sep">•</span><span className="text-capitalize">{run.frequency}</span></div>
            </div>
            <div className="text-end">
              <div className="tn-cost">Est. Total Cost {money.format(run.totals.gross + run.totals.employerTaxes)}</div>
              <StatusDot status={run.status} />
            </div>
          </article>
        ))}
      </div>}
    </section>
  </div>
}
