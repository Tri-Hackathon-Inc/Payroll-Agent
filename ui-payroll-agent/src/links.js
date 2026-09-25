// The mock TriNet payroll UI (ui-trinet-mock) is a separate app; this only links to it,
// in a new tab, with the selected domain.
const TRINET_MOCK_URL = import.meta.env.VITE_TRINET_MOCK_URL || 'http://localhost:5174/trinet/'

export function trinetUrl(domainName) {
  const url = new URL(TRINET_MOCK_URL, window.location.origin)
  if (domainName) url.searchParams.set('domain', domainName)
  return url.href
}
