import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSchema, graphql, GraphQLError } from 'graphql'

const REQUIRED_FIELDS = ['name', 'domain', 'description', 'instructions']

const readFile = (path) => fs.readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const readBody = (req) => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => resolve(body))
  req.on('error', reject)
})

export function graphqlMock() {
  const schema = buildSchema(readFile('../graphql/schema.graphql'))
  const { agents, ...catalog } = JSON.parse(readFile('./data.json'))

  const saveAgent = ({ input }) => {
    const missing = REQUIRED_FIELDS.filter((field) => !input[field].trim())
    if (missing.length) throw new GraphQLError(`Missing required fields: ${missing.join(', ')}`)

    const existing = input.id && agents.find(({ id }) => id === input.id)
    if (input.id && !existing) throw new GraphQLError(`Agent ${input.id} not found`)

    const agent = {
      id: existing?.id ?? String(agents.length + 1),
      name: input.name.trim(),
      domain: input.domain,
      description: input.description.trim(),
      instructions: input.instructions.trim(),
      model: input.model?.trim() ?? '',
      questions: (input.questions ?? []).map((question) => question.trim()).filter(Boolean),
    }
    if (existing) Object.assign(existing, agent)
    else agents.push(agent)
    return agent
  }

  const rootValue = {
    ...catalog,
    templates: ({ domain }) => catalog.templates.filter((template) => !domain || template.domain === domain),
    template: ({ id }) => catalog.templates.find((template) => template.id === id) ?? null,
    agents: () => [...agents].reverse(),
    agent: ({ id }) => agents.find((agent) => agent.id === id) ?? null,
    saveAgent,
  }

  return {
    name: 'graphql-mock',
    configureServer: (server) => {
      server.middlewares.use('/graphql', async (req, res) => {
        let request
        try {
          request = JSON.parse(await readBody(req))
        } catch {
          res.statusCode = 400
          res.end()
          return
        }

        const result = await graphql({
          schema,
          rootValue,
          source: request.query,
          variableValues: request.variables,
          operationName: request.operationName,
        })
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result))
      })
    },
  }
}
