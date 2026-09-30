"""Severity policy for saved payroll alerts, separate from median review indicators."""
from .common import at, numeric, rounded, valid_date
from .payroll import eligible_history, groups, matching_lines


def detect_signals(current, history):
    result = []
    for identity, lines in groups(current["lines"]).items():
        previous = [line for run in eligible_history(current, history)[:6] for line in matching_lines(run, identity, lines)]
        line = lines[0]

        def add(kind, detail, risk=None):
            severity = "info" if kind == "new hire" else "critical" if kind in ("duplicate payment", "paid after termination", "no tax withholding") or risk is not None and risk > 5000 else "warning"
            result.append({"employeeId": identity, "name": line.get("name", identity), "kind": kind, "detail": detail, "severity": severity,
                           "amountAtRisk": rounded(risk) if risk is not None else None, "evidence": {"lineIds": [item.get("lineId") for item in lines], "detail": detail}})

        if len(lines) > 1:
            risk = line["gross"] * (len(lines)-1) if numeric(line.get("gross")) else None
            add("duplicate payment", f"{len(lines)} payment lines for the same employee; verify any authorized split payments.", risk)
        for label, path, ratio, minimum in (("overtime", "hours.overtime", 2, 10), ("bonus", "earnings.bonus", 3, 1000), ("reimbursement", "earnings.reimbursement", 3, 500)):
            amount = at(line, path)
            past = [at(item, path) for item in previous if numeric(at(item, path))]
            if numeric(amount) and past and amount-max(past) >= minimum and amount > max(past)*ratio:
                add(label+" outlier", f"{label.capitalize()} {amount} versus historical range {min(past)}–{max(past)}.", amount-max(past) if label != "overtime" else None)
        for field, label in (("health", "health deduction"), ("retirement401k", "401(k) deduction")):
            past = [at(item, "deductions."+field) for item in previous]
            if past and all(numeric(value) and value > 0 for value in past) and at(line, "deductions."+field) == 0:
                add(label+" missing", f"{label.capitalize()} is zero; it was positive in every comparable historical payment.")
        gross = line.get("gross")
        if numeric(gross) and gross > 0:
            if at(line, "taxes.federal") == 0 and at(line, "taxes.state") == 0:
                add("no tax withholding", f"Federal and state withholding are both zero on gross {gross}.")
            if valid_date(line.get("terminationDate")) and line["terminationDate"] < current["periodEnd"]:
                add("paid after termination", f"Terminated {line['terminationDate']} with payment in this period; verify final-pay authorization.", gross)
        if not previous:
            add("new hire", "No comparable historical payment is available for this employee.")
    return result
