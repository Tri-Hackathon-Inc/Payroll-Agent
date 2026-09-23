export async function graphqlRequest(query, variables) {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await response.json().catch(() => ({}))
  if (payload.errors?.length) throw new Error(payload.errors[0].message)
  if (!response.ok) throw new Error(`Request failed (${response.status}).`)
  return payload.data
}
