export const TOOL_INFO: Record<string, { icon: string; group: string; status: string; description: string; via?: string }> = {
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
    icon: 'bi-slack', group: 'action', status: 'configurable',
    description: 'Posts incident alerts to a Slack channel.',
    via: 'Sent by the Incident Report agent when this tool is attached and SLACK_WEBHOOK_URL is set.',
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
