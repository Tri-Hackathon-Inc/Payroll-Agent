import { useState } from 'react'
import { payrollRequest } from './api'
import { CHANGE_NOTE, annualRate, exemption, hoursFmt, money, rateLabel } from './format'
import { UPDATE_PAY_LINE_MUTATION } from './operations'

// Editable inputs, as [group, field]; they match UpdatePayLineInput in the payroll API.
// Everything else (regular/overtime pay, taxes, 401(k), net) is recalculated by the API.
const MONEY_FIELDS = [['earnings', 'bonus'], ['earnings', 'reimbursement'], ['deductions', 'health'], ['deductions', 'garnishment']]
const HOUR_FIELDS = [['hours', 'regular'], ['hours', 'overtime']]
const PAYMENT_METHODS = ['Direct Deposit', 'Live Check']
const MAX_HOURS = 200

const key = (group, field) => `${group}.${field}`

function initialForm(line) {
  const form = { paymentMethod: line.paymentMethod }
  for (const [group, field] of [...HOUR_FIELDS, ...MONEY_FIELDS]) form[key(group, field)] = String(line[group][field])
  return form
}

// Returns { input, errors }: the changed fields shaped for UpdatePayLineInput, and any
// per-field validation messages.
function readForm(form, line, fields) {
  const input = {}
  const errors = {}
  for (const [group, field] of fields) {
    const raw = form[key(group, field)].trim()
    const value = Number(raw)
    const max = group === 'hours' ? MAX_HOURS : 1_000_000
    if (raw === '' || !Number.isFinite(value) || value < 0 || value > max) {
      errors[key(group, field)] = `Enter 0 to ${max.toLocaleString('en-US')}.`
      continue
    }
    if (value !== line[group][field]) (input[group] ||= {})[field] = value
  }
  if (form.paymentMethod !== line.paymentMethod) input.paymentMethod = form.paymentMethod
  return { input, errors }
}

function AmountInput({ id, label, value, error, onChange, step = '0.01', max, disabled }) {
  return <span className="tn-input-wrap">
    <input id={id} className={`tn-input${error ? ' invalid' : ''}`} type="number" inputMode="decimal" min="0" max={max} step={step}
      value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} aria-invalid={Boolean(error)}
      aria-describedby={error ? `${id}-error` : undefined} disabled={disabled} />
    {error && <small id={`${id}-error`} className="tn-field-error">{error}</small>}
  </span>
}

export default function EmployeeDrawer({ line, run, onClose, onSaved, onReload }) {
  const [form, setForm] = useState(() => initialForm(line))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const change = CHANGE_NOTE[line.employmentStatus]
  const hourly = line.payType === 'hourly'
  const editable = run.status === 'PENDING_APPROVAL'
  // Salaried pay doesn't depend on hours, and exempt employees don't earn overtime.
  const fields = hourly ? [...HOUR_FIELDS, ...MONEY_FIELDS] : MONEY_FIELDS
  const { input, errors } = readForm(form, line, fields)
  const dirty = Object.keys(input).length > 0
  const invalid = Object.keys(errors).length > 0
  const fieldError = (group, field) => errors[key(group, field)]
  const set = (name) => (value) => setForm((current) => ({ ...current, [name]: value }))
  const inputFor = (group, field, label, props = {}) => <AmountInput id={`tn-${group}-${field}`} label={label}
    value={form[key(group, field)]} error={fieldError(group, field)} onChange={set(key(group, field))} disabled={saving} {...props} />

  async function save(event) {
    event.preventDefault()
    if (!dirty || invalid || saving) return
    setSaving(true)
    setError(null)
    try {
      const data = await payrollRequest(UPDATE_PAY_LINE_MUTATION, {
        input: { payrunId: run.id, lineId: line.lineId, expectedVersion: run.version, ...input },
      })
      onSaved(data.updatePayLine, line.lineId)
    } catch (requestError) {
      // CONFLICT with currentVersion: someone else saved this payroll first.
      const stale = requestError.code === 'CONFLICT' && requestError.extensions?.currentVersion !== undefined
      setError({ message: requestError.message || 'The pay line could not be saved.', stale })
      setSaving(false)
    }
  }

  const details = [
    ['Employee ID', line.employeeId], ['Rate of pay', `${rateLabel(line, run)}${hourly ? ' / hr' : ' / yr'}`],
    ['Department', line.department], ['Net pay', money.format(line.net)],
    ['Type', `Full-Time, ${exemption(line)}`], ['Status', change ? change(line) : 'Active'],
  ]
  const taxes = [['Federal Income Tax', line.taxes.federal], ['State Income Tax', line.taxes.state], ['Social Security', line.taxes.socialSecurity], ['Medicare Tax', line.taxes.medicare]]

  return <aside className="tn-drawer" aria-label="Edit employee pay">
    <form className="d-flex flex-column h-100" onSubmit={save} noValidate>
      <div className="tn-drawer-head"><h2>Edit Employee Pay</h2><button type="button" className="tn-icon-btn" onClick={onClose} aria-label="Close"><i className="bi bi-x-lg" /></button></div>
      <div className="tn-drawer-body">
        <h3 className="tn-drawer-name">{line.name}</h3>
        <dl className="tn-details">
          {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          <div><dt><label htmlFor="tn-payment-method">Payment method</label></dt><dd>
            {editable
              ? <select id="tn-payment-method" className="tn-input tn-select" value={form.paymentMethod} onChange={(event) => set('paymentMethod')(event.target.value)} disabled={saving}>
                {PAYMENT_METHODS.map((method) => <option key={method}>{method}</option>)}
              </select>
              : line.paymentMethod}
          </dd></div>
          <div><dt>Standard Hours</dt><dd>40</dd></div>
        </dl>
        {!editable && <div className="tn-info"><i className="bi bi-lock" />This payroll is completed and locked. Only draft payrolls can be edited.</div>}
        {editable && change && <div className="tn-info"><i className="bi bi-info-circle" />Mid pay period changes have occurred. Please review for accuracy and update as needed.</div>}

        <div className="tn-section-head"><h4>Earnings</h4><span>Hours / Rate</span><span>Amount</span></div>
        <div className="tn-row">
          <span>Regular Wages</span>
          <span className="tn-row-rate">
            {editable && hourly ? inputFor('hours', 'regular', 'Regular hours', { step: '0.25', max: MAX_HOURS }) : <>{hoursFmt.format(line.hours.regular)}</>} <small>hr</small>
            <span className="ms-4">{hourly ? `${money.format(line.hourlyRate)} / hr` : `${money.format(annualRate(line, run))} / yr`}</span>
          </span>
          <span>{money.format(line.earnings.regular)}</span>
        </div>
        {(hourly || line.earnings.overtime > 0) && <div className="tn-row">
          <span>Overtime</span>
          <span className="tn-row-rate">
            {editable && hourly ? inputFor('hours', 'overtime', 'Overtime hours', { step: '0.25', max: MAX_HOURS }) : <>{hoursFmt.format(line.hours.overtime)}</>} <small>hr</small>
            {hourly && <span className="ms-4">{money.format(line.hourlyRate * 1.5)} / hr</span>}
          </span>
          <span>{money.format(line.earnings.overtime)}</span>
        </div>}
        {[['bonus', 'Bonus'], ['reimbursement', 'Reimbursement']].map(([field, label]) => (editable || line.earnings[field] > 0) && <div className="tn-row" key={field}>
          <span>{label}</span><span />
          <span>{editable ? inputFor('earnings', field, label) : money.format(line.earnings[field])}</span>
        </div>)}
        <div className="tn-row-total">Total Earnings: <strong>{money.format(line.gross)}</strong></div>

        <div className="tn-section-head"><h4>Estimated Employee Taxes</h4><span /><span>Amount</span></div>
        {taxes.map(([label, amount]) => <div className="tn-row" key={label}><span>{label}</span><span /><span>{money.format(amount)}</span></div>)}

        <div className="tn-section-head"><h4>Deductions</h4><span /><span>Amount</span></div>
        <div className="tn-row"><span>Health Insurance</span><span /><span>{editable ? inputFor('deductions', 'health', 'Health insurance') : money.format(line.deductions.health)}</span></div>
        <div className="tn-row"><span>401(k)</span><span /><span>{money.format(line.deductions.retirement401k)}</span></div>
        <div className="tn-row"><span>Garnishment</span><span /><span>{editable ? inputFor('deductions', 'garnishment', 'Garnishment') : money.format(line.deductions.garnishment)}</span></div>
        {editable && <p className="text-muted small mt-3 mb-0">Earnings, taxes, 401(k), and net pay are recalculated when you save.</p>}
      </div>
      {error && <div className="tn-save-error" role="alert">
        <i className="bi bi-exclamation-circle" /><span>{error.message}</span>
        {error.stale && <button type="button" className="tn-link ms-auto" onClick={onReload}>Reload payroll</button>}
      </div>}
      <div className="tn-drawer-foot">
        {editable ? <>
          <button type="button" className="tn-btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="tn-btn-primary" disabled={!dirty || invalid || saving || error?.stale}>
            {saving && <span className="spinner-border spinner-border-sm" aria-hidden="true" />}{saving ? 'Saving…' : 'Save'}
          </button>
        </> : <>
          <span className="text-muted small">Completed payroll</span>
          <button type="button" className="tn-btn-primary" onClick={onClose}>Close</button>
        </>}
      </div>
    </form>
  </aside>
}
