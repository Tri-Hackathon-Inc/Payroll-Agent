const PERIODS_PER_YEAR = { 'semi-monthly': 24, biweekly: 26, weekly: 52, monthly: 12 }

export const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
export const hoursFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const sum = (values) => Object.values(values).reduce((total, value) => total + value, 0)

const toDate = (iso) => new Date(`${iso}T00:00:00`)
export const usDate = (iso) => toDate(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
export const shortDay = (iso) => toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(' ', '')
export const longDay = (iso) => toDate(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
export const initials = (name) => name.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase()

export const STATUS = { PENDING_APPROVAL: 'Draft', COMPLETED: 'Completed' }
export const CHANGE_NOTE = {
  terminated: (line) => `Terminated ${usDate(line.terminationDate)}`,
  'new-hire': (line) => `New hire ${usDate(line.hireDate)}`,
}

// Employer share of FICA matches the employee's Social Security and Medicare withholding
// (the run's totals.employerTaxes is the same sum).
export const employerTaxes = (line) => line.taxes.socialSecurity + line.taxes.medicare
export const hours = (line) => line.hours.regular + line.hours.overtime
export const exemption = (line) => (line.payType === 'salary' ? 'Exempt' : 'Non-Exempt')
export const annualRate = (line, run) => line.periodSalary * (PERIODS_PER_YEAR[run.frequency] || 24)
export const rateLabel = (line, run) => money.format(line.payType === 'hourly' ? line.hourlyRate : annualRate(line, run))
