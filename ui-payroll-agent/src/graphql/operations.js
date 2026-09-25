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
      serviceOptions { id name domain enabled baseUrlEnv method path }
    }
  }
`

export const TEMPLATE_QUERY = `
  query GetTemplate($id: ID!) {
    getTemplate(id: $id) {
      id name description version config
      modelOptions { id name provider modelId details }
      serviceOptions { id name domain method path }
    }
  }
`

const AGENT_FIELDS = 'id name domainName templateId templateVersion config modelConfig createdAt updatedAt'

export const CHAT_AGENT_MUTATION = `
  mutation ChatAgent($input: ChatAgentInput!) {
    chatAgent(input: $input) { agentId modelId output demo session retrieval analysis }
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

export const UPDATE_AGENT_MUTATION = `
  mutation UpdateAgent($input: UpdateAgentInput!) {
    updateAgent(input: $input) { ${AGENT_FIELDS} }
  }
`
