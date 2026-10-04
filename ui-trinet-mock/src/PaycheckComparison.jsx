import { useId, useState } from 'react'
import { money, paycheckExplanation } from './paycheckPresentation'

function periodLabel(period) {
  if (!period) return 'No comparable history'
  return period.periodStart && period.periodEnd ? `${period.periodStart} to ${period.periodEnd}` : `Paid ${period.payDate}`
}

export default function PaycheckComparison({ comparisons }) {
  const [selected, setSelected] = useState('')
  const selectId = useId()
  const comparison = comparisons.find(item => item.employeeId === selected) || comparisons[0]
  if (!comparison) return null
  const explanation = paycheckExplanation(comparison)
  const rows = comparison.rows.filter(row => ['gross', 'net'].includes(row.key) || row.current !== 0 || row.previous !== 0)
  return <section className="tn-pay-comparison" aria-label="Paycheck comparison">
    <div className="tn-pay-question"><i className="bi bi-wallet2" aria-hidden="true" /><div>
      <strong>What changed in this paycheck?</strong><span>{comparison.employeeName}</span>
    </div></div>
    {comparisons.length > 1 && <label className="tn-pay-select" htmlFor={selectId}>Compare an employee
      <select id={selectId} className="form-select form-select-sm" value={comparison.employeeId} onChange={event => setSelected(event.target.value)}>
        {comparisons.map(item => <option key={item.employeeId} value={item.employeeId}>{item.employeeName}</option>)}
      </select>
    </label>}
    <div className="tn-pay-periods">{['previous', 'current'].map(side => <section key={side} className={`tn-pay-period ${side}`} aria-label={`${side} paycheck`}>
      <header><strong>{side === 'previous' ? 'Previous comparable paycheck' : 'Current paycheck'}</strong><span>{periodLabel(comparison[side])}</span></header>
      <dl>{rows.map(row => <div key={row.key} className={`tn-pay-row ${row.kind === 'net' ? 'net' : ''}`}>
        <dt>{row.label}</dt><dd>{row.kind === 'withholding' && Number.isFinite(row[side]) && row[side] !== 0 ? money(-row[side], comparison.currency) : money(row[side], comparison.currency)}
          {side === 'current' && Number.isFinite(row.delta) && row.delta !== 0 && <small>{row.delta < 0 ? '↓' : '↑'} {money(Math.abs(row.delta), comparison.currency)}</small>}
        </dd>
      </div>)}</dl>
    </section>)}</div>
    <div className="tn-pay-explanation"><i className="bi bi-bar-chart-line" aria-hidden="true" /><div>
      <strong>{explanation.title}</strong><p>{explanation.detail}</p>{explanation.note && <small>{explanation.note}</small>}
    </div></div>
    <p className="tn-pay-source">Calculated from saved payroll records. Multiple payment lines are combined. Changes are review indicators, not confirmed errors.</p>
  </section>
}
