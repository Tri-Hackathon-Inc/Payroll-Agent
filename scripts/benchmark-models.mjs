#!/usr/bin/env node
// Compares connected models on the Evaluation suites through the running stack's webhook:
// answer quality (content checks against the planted anomalies in payrun PR-2026-09-B),
// latency, and tokens per second. Every call is a real, billed model request.
//
//   node scripts/benchmark-models.mjs --dry-run            # list the planned calls only
//   node scripts/benchmark-models.mjs --runs 2 --out docs/model-benchmark.md
//   node scripts/benchmark-models.mjs --models qwen-2-5-72b
//   node scripts/benchmark-models.mjs --bank --models llama-3-3-70b   # the 64-question bank
//
// --bank runs ui-payroll-agent/src/questionBank.js on the General Query template's models and
// adds a pass rate per question category to the report.
//
// Requires the local stack (docker-compose.local.yaml) with HF_TOKEN set in the root .env.
import { writeFileSync } from 'node:fs'
import { EVALUATION_PAYRUN, EVALUATION_SUITES, gradeReply } from '../ui-payroll-agent/src/evaluationSuites.js'
import { QUESTION_BANK } from '../ui-payroll-agent/src/questionBank.js'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const STUDIO = option('studio', 'http://127.0.0.1:5173/ai_studio').replace(/\/+$/, '')
const DOMAIN = option('domain', option('business', 'payroll-services'))
const RUNS = Number(option('runs', 1))
const ONLY = option('models', '').split(',').filter(Boolean)
const DRY_RUN = args.includes('--dry-run')
const BANK = args.includes('--bank')
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
const bankSuite = { cases: QUESTION_BANK.flatMap(group => group.questions.map(item => ({ ...item, id: slug(item.prompt), category: group.category }))) }
const RUNNABLE = new Set(['huggingface', 'openai-compatible'])

async function graphql(query, variables) {
  const response = await fetch(`${STUDIO}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  const body = await response.json()
  if (body.errors?.length) throw new Error(body.errors[0].message)
  return body.data
}

// One agent per template and model, reused across runs.
async function benchmarkAgent(templateId, model, existing) {
  const name = `benchmark · ${templateId} · ${model.id}`
  const found = existing.find(agent => agent.name === name)
  if (found) return found
  const data = await graphql('mutation ($input: CreateAgentInput!) { createAgent(input: $input) { id name } }',
    { input: { domainName: DOMAIN, templateId, name, config: { model: model.id } } })
  return data.createAgent
}

async function ask(agent, prompt) {
  const response = await fetch(`${STUDIO}/webhook/${encodeURIComponent(DOMAIN)}/${encodeURIComponent(agent.id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: prompt, context: { page: 'payrun', payrunId: EVALUATION_PAYRUN, source: 'benchmark' } }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) return { error: body.message || `HTTP ${response.status}` }
  if (!body.metrics) return { error: body.reply }
  return body
}

const median = values => {
  const sorted = values.filter(value => value != null).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

const { getDomainAgentsTemplates: templates } = await graphql('query ($d: String!) { getDomainAgentsTemplates(domainName: $d) { id name modelOptions { id name provider modelId } } }', { d: DOMAIN })
const plan = []
for (const template of templates) {
  const suite = BANK ? (template.id === 'general-query' ? bankSuite : null) : EVALUATION_SUITES[template.id]
  if (!suite) continue
  for (const model of template.modelOptions) {
    if (!RUNNABLE.has(model.provider) || (ONLY.length && !ONLY.includes(model.id))) continue
    for (const item of suite.cases) plan.push({ template, suite, model, item })
  }
}
console.log(`${plan.length} case(s) x ${RUNS} run(s) = ${plan.length * RUNS} model call(s)`)
for (const { template, model, item } of plan) console.log(`  ${template.id} · ${model.id} · ${item.id}`)
if (DRY_RUN || !plan.length) process.exit(0)

const { getServiceAgentRegistry: existing } = await graphql('query ($d: String) { getServiceAgentRegistry(domainName: $d) { id name } }', { d: DOMAIN })
const rows = []
for (const { template, model, item } of plan) {
  const agent = await benchmarkAgent(template.id, model, existing)
  for (let run = 1; run <= RUNS; run += 1) {
    const answer = await ask(agent, item.prompt)
    const graded = answer.error ? [] : gradeReply(answer.reply, item.checks)
    rows.push({ template: template.id, model: model.id, modelId: model.modelId, case: item.id, category: item.category, run, error: answer.error,
      passed: graded.filter(check => check.passed).length, total: item.checks.length,
      latencyMs: answer.metrics?.latencyMs, tokensPerSecond: answer.metrics?.tokensPerSecond,
      completionTokens: answer.metrics?.completionTokens, provider: answer.metrics?.provider, reply: answer.reply })
    const row = rows.at(-1)
    console.log(`${row.template} · ${row.model} · ${row.case} #${run}: ${row.error ? `ERROR ${row.error}` : `${row.passed}/${row.total} checks, ${row.latencyMs} ms, ${row.tokensPerSecond ?? '?'} tok/s`}`)
  }
}

const models = [...new Set(rows.map(row => row.model))]
const lines = [
  `# Model benchmark (${new Date().toISOString().slice(0, 10)})`, '',
  `Evaluation suites against payrun ${EVALUATION_PAYRUN} through the Agent Studio webhook, ${RUNS} run(s) per case.`,
  'Latency is end-to-end (request to full answer, not streamed); tokens/s is completion tokens divided by that latency.', '',
  '| Model | Checks passed | Median latency | Median tokens/s | Errors |', '| --- | --- | --- | --- | --- |',
  ...models.map(id => {
    const own = rows.filter(row => row.model === id)
    const ok = own.filter(row => !row.error)
    return `| ${id} (${own[0].modelId}) | ${ok.reduce((s, r) => s + r.passed, 0)}/${own.reduce((s, r) => s + r.total, 0)} | ${median(ok.map(r => r.latencyMs)) ?? '–'} ms | ${median(ok.map(r => r.tokensPerSecond)) ?? '–'} | ${own.length - ok.length} |`
  }), '',
  ...(BANK ? ['| Category | Model | Checks passed | Questions fully correct |', '| --- | --- | --- | --- |',
    ...QUESTION_BANK.flatMap(group => models.map(id => {
      const own = rows.filter(row => row.model === id && row.category === group.category)
      return `| ${group.category} | ${id} | ${own.reduce((s, r) => s + r.passed, 0)}/${own.reduce((s, r) => s + r.total, 0)} | ${own.filter(r => !r.error && r.passed === r.total).length}/${own.length} |`
    })), ''] : []),
  '| Template | Model | Case | Run | Checks | Latency (ms) | Tokens/s | Completion tokens | Provider |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.template} | ${r.model} | ${r.case} | ${r.run} | ${r.error ? `error: ${r.error.replace(/\|/g, '/')}` : `${r.passed}/${r.total}`} | ${r.latencyMs ?? '–'} | ${r.tokensPerSecond ?? '–'} | ${r.completionTokens ?? '–'} | ${r.provider ?? '–'} |`),
  '', '## Answers', '',
  ...rows.filter(r => !r.error).flatMap(r => [`**${r.model} · ${r.case} #${r.run}**`, '', `> ${r.reply.replace(/\n/g, '\n> ')}`, '']),
]
const out = option('out')
if (out) { writeFileSync(out, `${lines.join('\n')}\n`); console.log(`Report written to ${out}`) } else console.log(`\n${lines.join('\n')}`)
