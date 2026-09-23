export const STUDIO_QUERY = `
  query Studio {
    domains { id label description icon }
    templates { id name domain description instructions questions model runtime icon }
    models { id label }
    tools { id name }
    agents { id name domain description instructions model questions }
  }
`

export const SAVE_AGENT_MUTATION = `
  mutation SaveAgent($input: SaveAgentInput!) {
    saveAgent(input: $input) { id name domain description instructions model questions }
  }
`
