// Mock TriNet payroll API (backend/trinet_mock/schema.graphql).
export const PAYRUNS_QUERY = `
  query Payruns {
    payruns { id company frequency periodStart periodEnd payDate status totals { gross employerTaxes } }
  }
`

// Everything the payrun page shows; the mutation returns the same shape so a save can
// replace the page's data directly.
const PAYRUN_FIELDS = `
  id company frequency periodStart periodEnd payDate status version
  totals { employees gross taxes deductions employerTaxes net }
  lines {
    lineId employeeId name department payType employmentStatus hireDate terminationDate
    hourlyRate periodSalary gross net paymentMethod
    hours { regular overtime }
    earnings { regular overtime bonus reimbursement }
    taxes { federal state socialSecurity medicare }
    deductions { health retirement401k garnishment }
  }
`

export const PAYRUN_QUERY = `
  query Payrun($id: ID!) {
    payrun(id: $id) { ${PAYRUN_FIELDS} }
  }
`

// Edits one pay line on a draft payrun; pay, taxes, and totals are recalculated server-side.
export const UPDATE_PAY_LINE_MUTATION = `
  mutation UpdatePayLine($input: UpdatePayLineInput!) {
    updatePayLine(input: $input) { ${PAYRUN_FIELDS} }
  }
`

// Agent Studio API (backend/graphql/schema.js).
export const DOMAINS_QUERY = `
  query ListDomains {
    listDomains { name label domain }
  }
`
