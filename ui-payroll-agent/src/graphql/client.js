export async function graphqlRequest(query, variables) {
  const response = await fetch(`${import.meta.env.BASE_URL}graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await response.json().catch(() => ({}))
  if (payload.errors?.length) {
    const error = new Error(payload.errors[0].message)
    error.code = payload.errors[0].extensions?.code
    throw error
  }
  if (!response.ok) throw new Error(`Request failed (${response.status}).`)
  if (!payload.data) throw new Error('The server did not return GraphQL data.')
  return payload.data
}
