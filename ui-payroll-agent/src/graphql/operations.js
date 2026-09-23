export const STUDIO_QUERY = `
  query GetStudio {
    getBusinesses { name label domain }
    getTemplates { id name description version config }
  }
`

export const TEMPLATE_QUERY = `
  query GetTemplate($id: ID!) {
    getTemplate(id: $id) {
      id name description version config
      modelOptions { id name provider modelId }
      serviceOptions { id name domain method path }
    }
  }
`

const AGENT_FIELDS = 'id name businessName templateId templateVersion config createdAt updatedAt'

export const BUSINESS_AGENTS_QUERY = `
  query GetBusinessAgents($businessName: String!) {
    getBusinessAgents(businessName: $businessName) { ${AGENT_FIELDS} }
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
