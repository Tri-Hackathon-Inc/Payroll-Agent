"""Read-only payroll access and deterministic evidence. No inference or payroll writes."""
import os
from collections import defaultdict
from statistics import median

from runtime.common import RuntimeFailure, at, numeric, rounded, total, valid_date
from runtime.common import request_json

LINE_FIELDS = """lineId employeeId name department payType employmentStatus hireDate terminationDate hourlyRate periodSalary
 hours { regular overtime } earnings { regular overtime bonus reimbursement } gross
 taxes { federal state socialSecurity medicare } deductions { health retirement401k garnishment } net paymentMethod"""
PAYRUN_FIELDS = """id name company frequency payDate periodStart periodEnd status currency version
 totals { employees gross taxes deductions employerTaxes net } lines { %s }""" % LINE_FIELDS
METRICS = {
    "gross": ("Gross pay", "gross", 100, 25), "net": ("Net pay", "net", 100, 25),
    "overtimeHours": ("Overtime hours", "hours.overtime", 10, 50),
    "regularHours": ("Regular hours", "hours.regular", 10, 25),
    "reimbursement": ("Reimbursement", "earnings.reimbursement", 100, 50),
    "bonus": ("Bonus", "earnings.bonus", 100, 50), "health": ("Health deduction", "deductions.health", 25, 25),
    "retirement401k": ("401k deduction", "deductions.retirement401k", 25, 25),
    "garnishment": ("Garnishment", "deductions.garnishment", 25, 25),
}


def load_context(invocation, history_limit=None):
    limit = max(1, min(int(history_limit or os.getenv("RAG_HISTORY_LIMIT", "100")), 500))
    query = "query AgentPayroll($id: ID!, $limit: Int!) { payrun(id: $id) { " + PAYRUN_FIELDS + " } payrunHistory(limit: $limit, before: $id) { " + PAYRUN_FIELDS + " } }"
    result = request_json(os.getenv("TRINET_API_URL", "http://trinet-api:4001/graphql"), {"query": query, "variables": {"id": invocation.get("payrunId"), "limit": limit}})
    data = result.get("data") or {}
    if result.get("errors") or not data.get("payrun"):
        raise RuntimeFailure("The requested payrun could not be loaded.", 404)
    return {"current": data["payrun"], "history": data.get("payrunHistory") or []}


def load_current(invocation):
    """The incremental anomaly path needs only the current source version."""
    query = "query AnomalyCurrent($id: ID!) { payrun(id: $id) { " + PAYRUN_FIELDS + " } }"
    result = request_json(os.getenv("TRINET_API_URL", "http://trinet-api:4001/graphql"),
                          {"query": query, "variables": {"id": invocation.get("payrunId")}})
    data = result.get("data") or {}
    if result.get("errors") or not data.get("payrun"):
        raise RuntimeFailure("The requested payrun could not be loaded.", 404)
    return data["payrun"]


def groups(lines):
    grouped = defaultdict(list)
    for line in lines:
        if not isinstance(line, dict) or not isinstance(line.get("employeeId"), str) or not line["employeeId"]:
            raise RuntimeFailure("Payroll lines require an employee ID.", 400)
        grouped[line["employeeId"]].append(line)
    return grouped


def eligible_history(current, history):
    seen, result = set(), []
    for run in history:
        if not isinstance(run, dict) or not run.get("id") or run["id"] in seen:
            continue
        # A duplicate ID never supplies a replacement snapshot.
        seen.add(run["id"])
        if (run["id"] == current["id"] or run.get("status") != "COMPLETED"
                or not valid_date(run.get("payDate")) or run["payDate"] >= current["payDate"]
                or not valid_date(run.get("periodEnd")) or run["periodEnd"] >= current["periodStart"]
                or any(run.get(k) != current.get(k) for k in ("company", "currency", "frequency"))
                or not isinstance(run.get("lines"), list)):
            continue
        result.append(run)
    return sorted(result, key=lambda run: (run["payDate"], run["periodEnd"]), reverse=True)


def matching_lines(run, employee_id, current_lines):
    previous = [line for line in run["lines"] if line.get("employeeId") == employee_id]
    types = {line.get("payType") for line in current_lines}
    return previous if previous and len(types) == 1 and None not in types and all(line.get("payType") in types for line in previous) else []


def preprocess(current, history, employee_id=None):
    if (not isinstance(current, dict) or not isinstance(current.get("lines"), list) or not isinstance(history, list)
            or not valid_date(current.get("payDate")) or not valid_date(current.get("periodStart"))
            or not all(current.get(k) for k in ("id", "company", "currency", "frequency"))):
        raise RuntimeFailure("A payrun with dated periods, company, currency, frequency and employee lines is required.", 400)
    grouped = groups(current["lines"])
    if employee_id is not None and (not isinstance(employee_id, str) or employee_id not in grouped):
        raise RuntimeFailure("The selected employee is not in this payrun.", 400)
    eligible = eligible_history(current, history)[:6]
    employees, findings = [], []
    for identity, lines in grouped.items():
        if employee_id and identity != employee_id:
            continue
        name = lines[0].get("name") or identity
        samples = [(run, matching_lines(run, identity, lines)) for run in eligible]
        samples = [(run, previous) for run, previous in samples if previous]
        values = {metric: total(lines, [rule[1]]) for metric, rule in METRICS.items()}
        comparisons = {}

        def add(code, label, evidence):
            findings.append({"id": f"{identity}:{code}", "employeeId": identity, "employeeName": name, "code": code,
                             "label": label, "severity": "review", "lineIds": [line["lineId"] for line in lines if line.get("lineId")], "evidence": evidence})

        for metric, (label, path, absolute, percent) in METRICS.items():
            available = [{"payrunId": run["id"], "payDate": run["payDate"], "value": total(previous, [path])} for run, previous in samples]
            available = [item for item in available if item["value"] is not None]
            amount = values[metric]
            if amount is None or not available:
                continue
            baseline = rounded(median(item["value"] for item in available))
            delta = rounded(amount - baseline)
            change = rounded(delta / abs(baseline) * 100) if baseline else None
            comparison = {"metric": metric, "unit": "hours" if metric.endswith("Hours") else current["currency"], "current": amount,
                          "baseline": baseline, "delta": delta, "percentChange": change, "historyCount": len(available), "history": available}
            comparisons[metric] = comparison
            if abs(delta) >= absolute and (not baseline or abs(change) >= percent):
                add(metric + "_change", label + " changed", comparison)
        if len(lines) > 1:
            add("multiple_lines", "Multiple payment lines; review for a possible duplicate", {"lineCount": len(lines)})
        previous_methods = {line.get("paymentMethod") for _, previous in samples for line in previous if line.get("paymentMethod")}
        methods = {line.get("paymentMethod") for line in lines if line.get("paymentMethod")}
        if previous_methods and methods - previous_methods:
            add("payment_method_change", "Payment method differs from historical payments", {"currentMethods": sorted(methods), "historicalMethods": sorted(previous_methods)})
        if values["net"] is not None and values["net"] < 0:
            add("negative_net", "Negative net pay", {"current": values["net"], "unit": current["currency"]})
        terminated = next((line for line in lines if line.get("employmentStatus") == "terminated" and valid_date(line.get("terminationDate")) and line["terminationDate"] < current["periodStart"]), None)
        if terminated and values["gross"] is not None and values["gross"] > 0:
            add("terminated_payment", "Payment after termination; verify final pay", {"terminationDate": terminated["terminationDate"], "current": values["gross"], "unit": current["currency"]})
        employees.append({"employeeId": identity, "name": name, "historyCount": len(samples), "historyStatus": "insufficient" if not samples else "limited" if len(samples) < 3 else "available",
                          "missingFields": [k for k, v in values.items() if v is None], "current": values, "comparisons": comparisons})
    return {"payrunId": current["id"], "payDate": current["payDate"], "currency": current["currency"], "employeeId": employee_id,
            "historyPayrunIds": [run["id"] for run in eligible], "method": "Median of up to six earlier completed payruns, matched by employee ID, company, currency, frequency and pay type.",
            "thresholds": {k: {"absolute": v[2], "percent": v[3]} for k, v in METRICS.items()}, "employees": employees, "findings": findings,
            "payrunFindings": payrun_findings(current, eligible) if not employee_id else []}


def payrun_findings(current, history):
    findings = []
    for field in ("gross", "net"):
        amount = total(current["lines"], [field])
        samples = [(run["id"], total(run["lines"], [field])) for run in history]
        samples = [(identity, value) for identity, value in samples if value is not None]
        if amount is None or not samples:
            continue
        baseline = rounded(median(value for _, value in samples))
        delta = rounded(amount-baseline)
        change = rounded(delta/abs(baseline)*100) if baseline else None
        if abs(delta) >= 100 and (not baseline or abs(change) >= 25):
            findings.append({"id": f"{current['id']}:{field}_total_change", "label": f"Payrun {field} total changed", "severity": "review",
                             "evidence": {"current": amount, "baseline": baseline, "delta": delta, "percentChange": change, "unit": current["currency"], "historyPayrunIds": [identity for identity, _ in samples]}})
    return findings


ROWS = [("gross", "Gross pay", "earning", ["gross"]), ("federal", "Federal tax", "withholding", ["taxes.federal"]),
        ("state", "State tax", "withholding", ["taxes.state"]), ("fica", "FICA", "withholding", ["taxes.socialSecurity", "taxes.medicare"]),
        ("health", "Health benefits", "withholding", ["deductions.health"]), ("retirement401k", "401(k)", "withholding", ["deductions.retirement401k"]),
        ("garnishment", "Garnishment", "withholding", ["deductions.garnishment"]), ("net", "Net pay", "net", ["net"])]


def pay_comparison(context, evidence):
    if len(evidence["employees"]) != 1:
        return None
    employee = evidence["employees"][0]
    current = context["current"]
    lines = [line for line in current["lines"] if line["employeeId"] == employee["employeeId"]]
    previous = next((run for run in eligible_history(current, context["history"]) if matching_lines(run, employee["employeeId"], lines)), None)
    old = matching_lines(previous, employee["employeeId"], lines) if previous else []
    rows = []
    for key, label, kind, paths in ROWS:
        amount, prior = total(lines, paths), total(old, paths)
        rows.append({"key": key, "label": label, "kind": kind, "current": amount, "previous": prior, "delta": rounded(amount-prior) if amount is not None and prior is not None else None})

    def period(run):
        return {"payrunId": run["id"], **{k: run.get(k) for k in ("payDate", "periodStart", "periodEnd")}} if run else None

    def reconciles(side):
        return all(row[side] is not None for row in rows) and rounded(rows[0][side] - sum(row[side] for row in rows if row["kind"] == "withholding")) == rows[-1][side]

    return {"employeeId": employee["employeeId"], "employeeName": employee["name"], "currency": current["currency"], "current": period(current), "previous": period(previous),
            "rows": rows, "netChange": rows[-1]["delta"], "reconciled": bool(previous and reconciles("current") and reconciles("previous")),
            "overtime": {"current": total(lines, ["earnings.overtime"]), "previous": total(old, ["earnings.overtime"]), "currentHours": total(lines, ["hours.overtime"]), "previousHours": total(old, ["hours.overtime"])}}
