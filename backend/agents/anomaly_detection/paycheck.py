"""Calculated review cards from the same immutable snapshot as the investigation."""
from runtime.payroll import pay_comparison


def review_comparisons(context, detection):
    analysis = detection.get("analysis", {})
    scope = analysis.get("employeeId")
    flagged = {f.get("employeeId") for f in detection.get("findings", [])}
    employees = [e for e in analysis.get("employees", [])
                 if e.get("employeeId") == scope or (not scope and e.get("employeeId") in flagged)]
    return [pay_comparison(context, {"employees": [employee]}) for employee in employees]
