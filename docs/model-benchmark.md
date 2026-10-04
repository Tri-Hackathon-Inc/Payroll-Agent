# Model benchmark (2026-09-25)

> Note: every Qwen error below is "no inference credits left"; the free monthly credit ran out
> during this run. See [model-evaluation-findings.md](model-evaluation-findings.md) for the
> interpretation, including Qwen's results from the earlier run.

Evaluation suites against payrun PR-2026-09-B through the Agent Studio webhook, 2 run(s) per case.
Latency is end-to-end (request to full answer, not streamed); tokens/s is completion tokens divided by that latency.

| Model | Checks passed | Median latency | Median tokens/s | Errors |
| --- | --- | --- | --- | --- |
| llama-3-3-70b (meta-llama/Llama-3.3-70B-Instruct) | 17/22 | 1767 ms | 39 | 0 |
| qwen-2-5-72b (Qwen/Qwen2.5-72B-Instruct) | 1/16 | 5788 ms | 30.9 | 7 |

| Template | Model | Case | Run | Checks | Latency (ms) | Tokens/s | Completion tokens | Provider |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| anomaly-detection | llama-3-3-70b | review-all | 1 | 5/8 | 4623 | 21.4 | 99 | – |
| anomaly-detection | llama-3-3-70b | review-all | 2 | 6/8 | 2870 | 39 | 112 | – |
| general-query | llama-3-3-70b | overtime | 1 | 1/1 | 3280 | 13.7 | 45 | – |
| general-query | llama-3-3-70b | overtime | 2 | 1/1 | 1743 | 43.6 | 76 | – |
| general-query | llama-3-3-70b | new-hire | 1 | 1/1 | 1557 | 50.1 | 78 | – |
| general-query | llama-3-3-70b | new-hire | 2 | 1/1 | 1215 | 64.2 | 78 | – |
| general-query | llama-3-3-70b | net-total | 1 | 1/1 | 1767 | 23.8 | 42 | – |
| general-query | llama-3-3-70b | net-total | 2 | 1/1 | 1137 | 30.8 | 35 | – |
| general-query | qwen-2-5-72b | overtime | 1 | 1/1 | 5788 | 30.9 | 179 | – |
| general-query | qwen-2-5-72b | overtime | 2 | error: Model call failed: the account has no inference credits left. (You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage.) | – | – | – | – |
| general-query | qwen-2-5-72b | new-hire | 1 | error: Model call failed: the account has no inference credits left. (You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage.) | – | – | – | – |
| general-query | qwen-2-5-72b | new-hire | 2 | error: Model call failed: the account has no inference credits left. (You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage.) | – | – | – | – |
| general-query | qwen-2-5-72b | net-total | 1 | error: Model call failed: the account has no inference credits left. (You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage.) | – | – | – | – |
| general-query | qwen-2-5-72b | net-total | 2 | error: Model call failed: the account has no inference credits left. (You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage.) | – | – | – | – |
| summarizer | qwen-2-5-72b | summary | 1 | error: Model call failed: the account has no inference credits left. (You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage.) | – | – | – | – |
| summarizer | qwen-2-5-72b | summary | 2 | error: Model call failed: the account has no inference credits left. (You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage.) | – | – | – | – |

## Answers

**llama-3-3-70b · review-all #1**

> Unusual payments that need review: 
> - E1004 Daniel Brooks: gross $28500 (bonus $25000), significantly higher than previous payrun ($4120) and historical data.
> - E1009 Jordan Reyes: new-hire with a higher gross ($4250) compared to other similar positions.
> - Duplicate payment for E1005 Aisha Karim.
> - E1008 Sam Patel: reimbursement ($1850) is unusual compared to previous payrun (no reimbursement).

**llama-3-3-70b · review-all #2**

> Unusual payments that need review: 
> - E1004 Daniel Brooks: gross $28500 (bonus $25000), significantly higher than previous payrun ($4120) and historical data.
> - E1006 Tom Becker: payment for a terminated employee.
> - Duplicate payment for E1005 Aisha Karim.
> - E1009 Jordan Reyes: new-hire with higher gross ($4250) compared to other similar employees. 
> - E1008 Sam Patel: reimbursement ($1850) is unusual compared to previous payrun (no reimbursement).

**llama-3-3-70b · overtime #1**

> Luis Ortega's pay is higher this run because he worked more overtime hours. 
> This run: 46 overtime hours, gross $4768.
> Previous run: 6 overtime hours, gross $2848.

**llama-3-3-70b · overtime #2**

> Luis Ortega's pay is higher this run because he worked more overtime hours. 
> Specifically, he worked 46 overtime hours in the current payrun (PR-2026-09-B), compared to 6 overtime hours in the previous payrun (PR-2026-09-A). 
> His gross pay increased from 2848 to 4768.

**llama-3-3-70b · new-hire #1**

> Jordan Reyes (E1009) is being paid for the first time in this payrun, as indicated by their status "new-hire". 
> 
> Supporting line: 
> E1009 | Jordan Reyes | Engineering | salary | new-hire | 80 | 0 | 0 | 0 | 0 | 4250 | 3532.37 | Direct Deposit

**llama-3-3-70b · new-hire #2**

> Jordan Reyes (E1009) is being paid for the first time in this payrun, as indicated by their status "new-hire". 
> 
> Supporting line: 
> E1009 | Jordan Reyes | Engineering | salary | new-hire | 80 | 0 | 0 | 0 | 0 | 4250 | 3532.37 | Direct Deposit

**llama-3-3-70b · net-total #1**

> The total net pay for this payrun is $44610.40.
> Supporting lines: All employee lines in the current payrun (PR-2026-09-B) contribute to this total.

**llama-3-3-70b · net-total #2**

> The total net pay for this payrun is $44610.40.
> Supporting data: Payroll totals for current payrun PR-2026-09-B.

**qwen-2-5-72b · overtime #1**

> Luis Ortega's pay is higher in the current payrun (PR-2026-09-B) because he worked more overtime hours. In the previous payrun (PR-2026-09-A), he worked 6 overtime hours, while in the current payrun, he worked 46 overtime hours.
> 
> - **Previous payrun (PR-2026-09-A):**
>   - Overtime hours: 6
>   - Gross pay: $2,848
>   - Net pay: $1,882.04
> 
> - **Current payrun (PR-2026-09-B):**
>   - Overtime hours: 46
>   - Gross pay: $4,768
>   - Net pay: $3,251.96

