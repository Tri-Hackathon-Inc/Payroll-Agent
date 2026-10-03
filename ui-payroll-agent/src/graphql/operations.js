export const STUDIO_QUERY = `
  query GetStudio {
    listDomains { name label domain }
  }
`

export const DOMAINS_QUERY = `
  query ListDomains {
    listDomains { name label domain }
  }
`

// Templates of one domain with everything the studio, Tools and Models views need.
export const DOMAIN_TEMPLATES_QUERY = `
  query GetDomainAgentsTemplates($domainName: String!) {
    getDomainAgentsTemplates(domainName: $domainName) {
      id name description version config
      modelOptions { id name provider modelId enabled details }
      serviceOptions { id name domain enabled baseUrlEnv method path operations }
    }
  }
`

export const TEMPLATE_QUERY = `
  query GetTemplate($id: ID!) {
    getTemplate(id: $id) {
      id name description version config
      modelOptions { id name provider modelId details }
      serviceOptions { id name domain method path operations }
    }
  }
`

const AGENT_FIELDS = 'id name domainName templateId templateVersion config modelConfig createdAt updatedAt'

export const CHAT_AGENT_MUTATION = `
  mutation ChatAgent($input: ChatAgentInput!) {
    chatAgent(input: $input) { agentId modelId output demo session retrieval analysis status questionMapping mappedQuestion }
  }
`

export const SERVICE_AGENT_REGISTRY_QUERY = `
  query GetServiceAgentRegistry($domainName: String, $serviceName: String) {
    getServiceAgentRegistry(domainName: $domainName, serviceName: $serviceName) { ${AGENT_FIELDS} }
  }
`

export const CREATE_AGENT_MUTATION = `
  mutation CreateAgent($input: CreateAgentInput!) {
    createAgent(input: $input) { ${AGENT_FIELDS} }
  }
`

export const DELETE_AGENT_MUTATION = `
  mutation DeleteAgent($id: ID!, $domainName: String!) {
    deleteAgent(id: $id, domainName: $domainName)
  }
`

export const UPDATE_AGENT_MUTATION = `
  mutation UpdateAgent($input: UpdateAgentInput!) {
    updateAgent(input: $input) { ${AGENT_FIELDS} }
  }
`

export const AGENT_PIPELINE_QUERY = `
  query AgentPipeline($domainName: String!, $agentId: ID!, $anomalyId: ID) {
    agentPipeline(domainName: $domainName, agentId: $agentId, anomalyId: $anomalyId)
  }
`

// Admin metrics (Agent Metrics view) and answer feedback.
export const AGENT_METRICS_QUERY = `
  query AgentMetrics($domainName: String!, $agentId: ID, $sinceHours: Int) {
    agentMetrics(domainName: $domainName, agentId: $agentId, sinceHours: $sinceHours)
  }
`

export const RATE_ANSWER_MUTATION = `
  mutation RateAnswer($input: RateAnswerInput!) {
    rateAnswer(input: $input)
  }
`

// Who is using the Studio: role (admin or user) and the features turned on for it.
export const VIEWER_QUERY = `
  query Viewer {
    viewer { role features authMode allowedModels allowedTools }
  }
`
