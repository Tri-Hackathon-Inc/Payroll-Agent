# Model benchmark (2026-09-25)

Evaluation suites against payrun PR-2026-09-B through the Agent Studio webhook, 1 run(s) per case.
Latency is end-to-end (request to full answer, not streamed); tokens/s is completion tokens divided by that latency.

| Model | Checks passed | Median latency | Median tokens/s | Errors |
| --- | --- | --- | --- | --- |
| llama-3-3-70b (meta-llama/Llama-3.3-70B-Instruct) | 11/11 | 4376 ms | 19.4 | 0 |

| Template | Model | Case | Run | Checks | Latency (ms) | Tokens/s | Completion tokens | Provider |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| anomaly-detection | llama-3-3-70b | review-all | 1 | 8/8 | 11512 | 27.8 | 320 | – |
| general-query | llama-3-3-70b | overtime | 1 | 1/1 | 4376 | 9.4 | 41 | – |
| general-query | llama-3-3-70b | new-hire | 1 | 1/1 | 1961 | 19.4 | 38 | – |
| general-query | llama-3-3-70b | net-total | 1 | 1/1 | 978 | 17.4 | 17 | – |

## Answers

**llama-3-3-70b · review-all #1**

> The payments that need review are those with unusual values or discrepancies compared to historical payrun data.
>
> - E1002 Luis Ortega: overtime outlier: overtime 46h vs 2–6h in the last 3 runs - unusually high overtime hours may indicate an error or require verification.
> - E1004 Daniel Brooks: bonus outlier: bonus $25,000 vs $620–$850 in the last 3 runs - a significantly higher bonus amount may need review to ensure accuracy.
> - E1005 Aisha Karim: duplicate payment: 2 pay lines for the same employee in this run (gross $2,197 each) - duplicate payments may result in overpayment and require correction.
> - E1006 Tom Becker: paid after termination: terminated 2026-09-12 but paid gross $4,500 for 2026-09-16 to 2026-09-30 (entire period after termination) - payment after termination may indicate an error or require verification.
> - E1007 Grace Liu: health deduction missing: health deduction is $0 this run vs $150 in the last 3 runs - missing health deduction may need review to ensure accuracy.
> - E1008 Sam Patel: reimbursement outlier: reimbursement $1,850 vs $0–$35 in the last 3 runs - a significantly higher reimbursement amount may need review to ensure accuracy.
> - E1009 Jordan Reyes: no tax withholding: federal and state withholding are both $0 on gross $4,250 - lack of tax withholding may indicate an error or require verification.

**llama-3-3-70b · overtime #1**

> Luis Ortega's pay is higher this run because he worked 46 hours of overtime, which is significantly more than his usual 2-6 hours of overtime in the last 3 runs.

**llama-3-3-70b · new-hire #1**

> E1009 Jordan Reyes is being paid for the first time in this payrun, as indicated by their new-hire status and hire date of 2026-09-16.

**llama-3-3-70b · net-total #1**

> The total net pay for this payrun is $44,610.40.
