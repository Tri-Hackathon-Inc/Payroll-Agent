# Model benchmark (2026-09-25)

Evaluation suites against payrun PR-2026-09-B through the Agent Studio webhook, 1 run(s) per case.
Latency is end-to-end (request to full answer, not streamed); tokens/s is completion tokens divided by that latency.

| Model | Checks passed | Median latency | Median tokens/s | Errors |
| --- | --- | --- | --- | --- |
| llama-3-3-70b (meta-llama/Llama-3.3-70B-Instruct) | 8/11 | 4392 ms | 62.1 | 0 |

| Template | Model | Case | Run | Checks | Latency (ms) | Tokens/s | Completion tokens | Provider |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| anomaly-detection | llama-3-3-70b | review-all | 1 | 5/8 | 6956 | 18 | 125 | – |
| general-query | llama-3-3-70b | overtime | 1 | 1/1 | 1191 | 65.5 | 78 | – |
| general-query | llama-3-3-70b | new-hire | 1 | 1/1 | 1465 | 62.1 | 91 | – |
| general-query | llama-3-3-70b | net-total | 1 | 1/1 | 4392 | 31.9 | 140 | – |

## Answers

**llama-3-3-70b · review-all #1**

> Unusual payments that need review: 
> * E1004 Daniel Brooks: gross payment of $28500 is significantly higher than the previous payrun's gross of $4120, with a large bonus of $25000.
> * E1005 Aisha Karim: duplicate payment lines with identical information.
> * E1009 Jordan Reyes: new-hire with a relatively high gross payment of $4250 and low employee taxes of $325.13, which may indicate incorrect tax setup.
> * E1008 Sam Patel: reimbursement of $1850 is significantly higher than the previous payrun's reimbursement of $0.

**llama-3-3-70b · overtime #1**

> Luis Ortega's pay is higher this run because he worked more overtime hours. 
> Specifically, he worked 46 overtime hours this run (E1002 | Luis Ortega | ... | 80 | 46 | ...), compared to 6 overtime hours in the previous run (E1002 | Luis Ortega | ... | 80 | 6 | ...).

**llama-3-3-70b · new-hire #1**

> Jordan Reyes (E1009) is being paid for the first time in this payrun, as indicated by their status "new-hire". 
> 
> Supporting line: 
> E1009 | Jordan Reyes | Engineering | salary | new-hire | 80 | 0 | 0 | 0 | 4250 | 325.13 | 180 | 212.5 | 0 | 3532.37 | Direct Deposit

**llama-3-3-70b · net-total #1**

> The total net pay for this payrun is $44610.40.
> Supporting lines: All employee lines contribute to this total, including:
> - E1001: $3287.50
> - E1002: $3251.96
> - E1003: $2634.00
> - E1004: $20469.75
> - E1005 (duplicated): $1469.53 * 2 = $2939.06
> - E1006: $2985.75
> - E1007: $2318.87
> - E1008: $3191.14
> - E1009: $3532.37

