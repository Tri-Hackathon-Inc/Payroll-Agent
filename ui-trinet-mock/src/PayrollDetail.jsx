import { useState } from 'react'
import { CHANGE_NOTE, STATUS, employerTaxes, exemption, hours, hoursFmt, initials, longDay, money, rateLabel, shortDay, sum, usDate } from './format'

export default function PayrollDetail({ run, notice, onDismissNotice, onBack, onSelectLine }) {
  const [search, setSearch] = useState('')
  const [bannerOpen, setBannerOpen] = useState(true)
  const query = search.trim().toLowerCase()
  const visible = run.lines.filter((line) => !query || line.name.toLowerCase().includes(query) || line.employeeId.toLowerCase().includes(query))
  const totalHours = run.lines.reduce((value, line) => value + hours(line), 0)
  const tiles = [
    ['Hours Paid', hoursFmt.format(totalHours)],
    ['Gross Pay', money.format(run.totals.gross)],
    ['Deductions', money.format(run.totals.deductions)],
    ['Est. Employee Taxes', money.format(run.totals.taxes)],
    ['Est. Net Pay', money.format(run.totals.net)],
    ['Est. Employer Taxes', money.format(run.totals.employerTaxes)],
    ['Employer Contributions', money.format(0)],
  ]
  return <div className="tn-page tn-page-wide">
    {notice && <div className="tn-success" role="status">
      <i className="bi bi-check-circle" /><span>{notice}</span>
      <button type="button" className="tn-icon-btn ms-auto" onClick={onDismissNotice} aria-label="Dismiss"><i className="bi bi-x-lg" /></button>
    </div>}
    {bannerOpen && run.lines.some((line) => CHANGE_NOTE[line.employmentStatus]) && <div className="tn-warning">
      <i className="bi bi-exclamation-circle" /><span>Some employees have payroll changes. Make sure any changes are accurate.</span>
      <button type="button" className="tn-icon-btn ms-auto" onClick={() => setBannerOpen(false)} aria-label="Dismiss"><i className="bi bi-x-lg" /></button>
    </div>}
    <button type="button" className="tn-link tn-back" onClick={onBack}><i className="bi bi-chevron-left me-2" />Back</button>
    <div className="d-flex align-items-center gap-3 mb-1 flex-wrap">
      <h1 className="tn-title mb-0">Payroll for {shortDay(run.periodStart)} - {shortDay(run.periodEnd)} ({longDay(run.periodStart)} - {longDay(run.periodEnd)})</h1>
      <span className="tn-badge-outline">{STATUS[run.status] || run.status}</span>
    </div>
    <div className="tn-dates">Debit Date: {usDate(run.payDate)}<span className="tn-sep">•</span>Pay Date: {usDate(run.payDate)}<span className="tn-sep">•</span>{run.company}</div>
    <div className="tn-tiles">{tiles.map(([label, value]) => <div className="tn-tile" key={label}><div className="tn-tile-label">{label}</div><div className="tn-tile-value">{value}</div></div>)}</div>
    <section className="tn-card">
      <div className="tn-table-head">
        <strong>{run.lines.length} Total Employees</strong>
        <label className="tn-search"><i className="bi bi-search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Enter Employee Name or ID" aria-label="Search employees" /></label>
      </div>
      <div className="table-responsive">
        <table className="tn-table">
          <thead><tr><th>Employee Name</th><th>Rate</th><th>Hours</th><th>Gross Pay</th><th>Deductions</th><th>Est. Employee Taxes</th><th>Est. Net Pay</th><th>Est. Employer Taxes</th><th>Employer Contributions</th><th>Payment Method</th></tr></thead>
          <tbody>
            {visible.map((line) => {
              const change = CHANGE_NOTE[line.employmentStatus]
              return <tr key={line.lineId}>
                <td>
                  <div className="d-flex align-items-center gap-3">
                    <span className="tn-avatar">{initials(line.name)}</span>
                    <div>
                      <button type="button" className="tn-link fw-semibold" onClick={() => onSelectLine(line.lineId)}>{line.name}</button>
                      {change && <i className="bi bi-exclamation-circle tn-change-icon" title={change(line)} aria-label={change(line)} />}
                      <div className="tn-meta">ID: {line.employeeId} • Full-Time<br />{exemption(line)}</div>
                    </div>
                  </div>
                </td>
                <td>{rateLabel(line, run)}</td>
                <td>{hoursFmt.format(hours(line))}</td>
                <td>{money.format(line.gross)}</td>
                <td>{money.format(sum(line.deductions))}</td>
                <td>{money.format(sum(line.taxes))}</td>
                <td>{money.format(line.net)}</td>
                <td>{money.format(employerTaxes(line))}</td>
                <td>{money.format(0)}</td>
                <td className="text-start">{line.paymentMethod}</td>
              </tr>
            })}
            {!visible.length && <tr><td colSpan={10} className="text-center text-muted py-4">No employees match your search.</td></tr>}
          </tbody>
          <tfoot><tr><td /><td /><td>{hoursFmt.format(totalHours)}</td><td>{money.format(run.totals.gross)}</td><td>{money.format(run.totals.deductions)}</td><td>{money.format(run.totals.taxes)}</td><td>{money.format(run.totals.net)}</td><td>{money.format(run.totals.employerTaxes)}</td><td>{money.format(0)}</td><td /></tr></tfoot>
        </table>
      </div>
    </section>
  </div>
}
