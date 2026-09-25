# Agent model evaluation: first findings (2026-09-25)

Throwaway spike requested in the Sep 24 review: connect an Agent Studio agent to a real model,
ask it questions from the TriNet payrun page, and learn about **model configuration**,
**pre-processing of the query**, and **the response**. Raw output of the last run is in
[`model-benchmark.md`](model-benchmark.md).

## Setup

- **Path:** TriNet payrun assistant → Agent Studio webhook (Apollo host) → Hugging Face
  router (`https://router.huggingface.co/v1`, OpenAI-compatible `chat/completions`) → provider.
  The token (`HF_TOKEN`) stays on the server; see `backend/README.md`, "Agent model calls".
- **Pre-processing:** the webhook loads the open payrun and the previous completed payrun
  from the payroll API and puts them in the prompt with the agent's instructions and
  guardrails (answer only from the data, never change payroll).
- **Test set:** the Evaluation suites (`ui-payroll-agent/src/evaluationSuites.js`) against
  payrun PR-2026-09-B, which has seven planted anomalies. A check passes when the answer names
  the right employee or figure. Run with `node scripts/benchmark-models.mjs`.

## Model availability and price on Hugging Face

Checked with the router's model list (`GET /v1/models`) on 2026-09-25: 137 models served.

| Model | Served? | Providers (USD per million input / output tokens, as listed) |
| --- | --- | --- |
| Llama 3.1 70B Instruct | **No** ("not supported by any provider") | none |
| Llama 3.3 70B Instruct | Yes | novita 0.135 / 0.40, ovhcloud 0.74 / 0.74, scaleway 1.026 / 1.026, together 1.04 / 1.04, featherless-ai (no price listed) |
| Qwen2.5 72B Instruct | Yes | deepinfra 0.36 / 0.40, novita 0.38 / 0.40, featherless-ai (no price listed) |

Llama 3.1 70B was replaced by **Llama 3.3 70B** in the model catalog for this reason.

**Credits:** free accounts get $0.10/month of Inference Providers credit (PRO $2/month; beyond
that, prepaid pay-as-you-go at provider rates, no Hugging Face markup). In this spike the free
credit ran out after about 27 calls, including several long anomaly and summary prompts. The
free tier covers roughly one benchmark pass, not ongoing testing. Rate limits were not reached;
credits were the binding limit.

## Results

Latency is end-to-end, from request to full answer (not streamed). Tokens/s is completion tokens
divided by that latency, so short answers look slower because the time to first token dominates.

| Model | Suite | Checks passed | Latency | Tokens/s |
| --- | --- | --- | --- | --- |
| Llama 3.3 70B | Planted anomalies (2 runs) | 5/8, 6/8 | 4.6 s, 2.9 s | 21, 39 |
| Llama 3.3 70B | Payrun Q&A, 3 questions × 2 runs | 6/6 | 1.1–3.3 s (median 1.8 s overall) | 14–64 |
| Qwen2.5 72B | Payrun Q&A, 4 answers (3 questions, one repeated) | 4/4 | 3.4–5.8 s | 6–31 |
| Qwen2.5 72B | Payrun summary, 1 run | 5/5 | 44.3 s | 23 |

Qwen was not run on the anomaly suite, because the Anomaly Detection template does not offer
it. Its remaining calls in the second run failed only because the credits ran out.

Example answer (Qwen, "What is the total net pay for this payrun?"): "The total net pay for this
payrun is $44,610.40." Correct, 3.7 s.

## What we learned

**Pre-processing matters most.** Llama missed Grace Liu's missing health deduction in both runs.
The cause was our context: it only included garnishment, not the health or 401(k) deductions
or per-employee taxes. The context now includes all deductions and each employee's total taxes
(about 3,200 characters, roughly 1,500 prompt tokens), but this has **not been re-measured
yet** (no credits). Llama also missed the overtime spike (Luis Ortega, 46 overtime hours) even
though the hours were in the data. Candidate fix: have pre-processing compute per-employee
changes against the previous run (hours, gross, deductions) so anomalies are explicit, rather
than asking the model to diff two tables.

**Response.** Answers were concise and grounded in the data. Short Q&A answers took 1–6 s,
which is fine for a chat panel. Long summaries (44 s) need streaming or a lower `max_tokens`
before they are usable in the UI. Showing the results is Praneeth's part.

**Model choice.** Llama 3.3 70B was the fastest (median 1.8 s) and has the cheapest provider
listed (novita, $0.135 per million input tokens), which makes it a good default for the
real-time anomaly agent. Qwen2.5 72B answered every question it was asked correctly, including
the summary, but was slower. Quality differences need more runs than the free credit allowed.

## Answer tuning (2026-09-25, Llama 3.3 70B)

Tuned on four target questions against payrun PR-2026-09-B, one run per question per round.
Raw answers: [`tuning/round-0-baseline.md`](tuning/round-0-baseline.md),
[`tuning/round-1-signals.md`](tuning/round-1-signals.md),
[`tuning/round-2-repeat.md`](tuning/round-2-repeat.md).

| Question | Baseline | After tuning (2 runs) |
| --- | --- | --- |
| Which payments need review? | 5/8 checks; missed Luis Ortega (overtime), Tom Becker (paid after termination), Grace Liu (health deduction) | 8/8 and 8/8: all seven planted anomalies, normal pay not flagged |
| Why is Luis Ortega's pay higher this run? | Correct, but pasted raw data rows | Correct, one sentence ("46 hours of overtime … vs 2-6") |
| Who is being paid for the first time? | Correct, pasted a raw row | Correct, one sentence with the hire date |
| What is the total net pay for this payrun? | Correct, but listed every employee | Correct single figure ($44,610.40) in round 1; round 2 hit the credit limit |

What changed, all in pre- and post-processing (no model training):

1. **More data in the context:** hire and termination dates, federal and state tax separately,
   and the last three completed runs instead of one, shown as a history range per value.
2. **Automated checks** (`detectSignals` in `backend/graphql/payrunContext.js`): generic rules
   comparing each employee with their own history (overtime, bonus, and reimbursement
   outliers, a deduction dropping to zero, no tax withholding, pay after the termination
   date, duplicate pay lines, new hires). They caught all seven planted anomalies with no
   false positives on the seed data; the model verifies and explains them.
3. **Answer rules** (`ANSWER_RULES` in `backend/graphql/agentPrompt.js`): direct answer first,
   one line per employee finding, totals from the Totals line, no raw data dumps.

These functions are standalone so they can move into the backend's model class
(pre-processing and post-processing) without changes. Because the checks now surface the
anomalies, the evaluation measures the checks and the model together; new kinds of
anomalies need a new check or will rely on the model alone.

## Agent-to-agent (incident reports)

Implemented as agreed after the answer tuning: an Anomaly Detection conversation is handed to an
Incident Report agent, which collects evidence from the payroll API (pay-line snapshots, history,
amounts at risk), writes the report (model when connected, otherwise from the evidence), and
emails it through the email notification tool. On the seed payrun it reports 7 issues and
$32,662.00 at risk (bonus above history $24,150, paid after termination $4,500, duplicate line
$2,197, reimbursement above history $1,815). A headless browser (evidence-capture service)
adds read-only screenshots of each finding: 15 images (pay rows and Edit Employee Pay drawers)
in about 6 seconds, embedded in the downloaded report. See the backend README, "Agent-to-agent".

## Next steps

1. Get credits for further testing: a PRO seat, a team organization billed with the
   `X-HF-Bill-To` header, or prepaid credit. Then re-run
   `node scripts/benchmark-models.mjs --runs 3` to measure the context fix.
2. Done: per-employee history and automated checks (see Answer tuning). The question set is
   now 14 questions across Anomaly Detection (5), General Query (6), and Summarizer (3), each
   with answer checks in `evaluationSuites.js`, and the context has a "Payrun facts" section
   (previous-run comparison, department costs, counts, overtime, largest changes) so totals
   and comparisons are computed in code. These new questions are **not yet measured** (no
   credits): run `node scripts/benchmark-models.mjs --models llama-3-3-70b` (11 calls) and
   the Qwen-only questions next.
3. Question bank: 64 questions in 11 categories with checks (`ui-payroll-agent/src/questionBank.js`),
   run with `--bank`. The context now carries every pay-line field (rates, earnings split, all
   four taxes, deductions, payment method) and run-wide totals per tax, deduction, and
   earning type, and the rules allow general payroll explanations, decline actions, and say
   when data (e.g. SSNs) is not available. **Not yet measured** (no credits); about 64 calls
   on Llama 3.3.
3. Stream answers, or cap `max_tokens`, for summaries.
4. Show the measured latency and tokens/s on the model cards in the Studio, which currently
   show "not measured yet".
