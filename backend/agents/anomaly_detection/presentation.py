"""Evidence-based admin summaries; no inference or changes to detector decisions."""


def admin_summary(snapshot):
    detection = snapshot["detection"]
    findings = [f for f in detection.get("findings", []) if f.get("severity") in ("warning", "critical")]
    critical = sum(f.get("severity") == "critical" for f in findings)
    employees = {f["employeeId"] for f in findings if f.get("employeeId")}
    analysis = detection.get("analysis", {})
    groups = {}
    for finding in sorted(findings, key=lambda f: f.get("severity") != "critical"):
        who = (finding.get("employeeName") or finding.get("name") or finding["employeeId"]) if finding.get("employeeId") else "Whole payrun"
        key = finding.get("employeeId") or "payrun"
        group = groups.setdefault(key, {"subject": who, "items": []})
        label = finding.get("label") or finding.get("detail") or finding.get("kind", "Review requested")
        if label not in group["items"]:
            group["items"].append(label)
    limitations = []
    limited = sum(e.get("historyStatus") != "available" for e in analysis.get("employees", []))
    if limited:
        limitations.append(f"Limited comparable history for {limited} employee(s). Historical checks may miss unusual changes.")
    status = analysis.get("decisionModelStatus")
    if status and status not in ("completed", "skipped"):
        limitations.append("Additional model scoring was unavailable. These results use the available rules and historical checks. Model setup details are in My Agents → Model pipeline.")
    coverage = f"{len(employees)} employee{'s' if len(employees) != 1 else ''}" if employees else "the payrun"
    if employees and any(not f.get("employeeId") for f in findings):
        coverage += " and the payrun overall"
    summary = (f"{len(findings)} checks flagged for review across {coverage}. {critical} high-priority flags."
               if findings else "No payroll issues were flagged by the available checks.")
    return {"summary": summary, "priorities": list(groups.values())[:3], "remainingGroups": max(0, len(groups) - 3),
            "limitations": limitations,
            "nextStep": "Check the flagged payments against approved hours, bonuses, deductions and employee records. Flags are possible issues, not confirmed errors. Review asks the agent to investigate; dismiss only if you have verified the payments are expected."}
