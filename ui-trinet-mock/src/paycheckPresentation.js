export function money(value, currency = 'USD') {
  if (!Number.isFinite(value)) return 'Not available'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)
}

export function paycheckExplanation(comparison) {
  const { netChange, currency, rows, previous, reconciled } = comparison
  const amount = value => money(Math.abs(value), currency)
  if (!previous) return { title: 'No comparable previous paycheck', detail: 'Current amounts are available, but there is no eligible earlier payment to compare.' }
  if (!Number.isFinite(netChange)) return { title: 'Net-pay comparison is incomplete', detail: 'A net-pay amount is missing. Check the payroll records.' }
  const title = netChange === 0 ? 'Take-home pay is unchanged' : `Take-home pay is ${amount(netChange)} ${netChange < 0 ? 'lower' : 'higher'}`
  const changes = rows.filter(row => row.kind !== 'net' && Number.isFinite(row.delta) && row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  const hasEarningChange = changes.some(row => ['regular', 'overtime', 'bonus', 'reimbursement'].includes(row.key))
  const causes = hasEarningChange ? changes.filter(row => row.key !== 'gross') : changes
  const detail = causes.slice(0, 3).map(row => `${row.label} ${row.delta < 0 ? 'decreased' : 'increased'} by ${amount(row.delta)}`).join('; ')
  return { title, detail: detail ? `${detail}.` : 'The available pay components show no change.',
    note: reconciled ? 'Gross pay minus the listed taxes and deductions matches take-home pay in both periods.'
      : 'The available components do not fully reconcile both net amounts. Check missing or additional pay items before drawing a conclusion.' }
}
