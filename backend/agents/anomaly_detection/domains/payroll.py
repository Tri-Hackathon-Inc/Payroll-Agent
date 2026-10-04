"""Payroll loading, identity, presentation and metrics behind the common agent."""
from ..interface import EntityReference


class PayrollDomain:
    def reference(self, context):
        current = context["current"]
        return EntityReference("payrun", current["id"], current.get("version"), current.get("company", ""))

    def load(self, invocation):
        from runtime.payroll import load_context
        return load_context(invocation)

    def invocation(self, reference):
        return {"payrunId": reference.identity}

    def selected(self, invocation):
        return bool(invocation.get("payrunId"))

    def scope(self, invocation):
        return invocation.get("employeeId")

    def event_details(self, event, detection):
        employee = next((item for item in detection["analysis"]["employees"] if item["employeeId"] == event.get("employeeId")), None)
        reason = {"payrun.loaded": "a payrun API read", "paycheck.opened": "an employee paycheck API read"}.get(event.get("type"), "a saved payroll change")
        return {"reason": reason, "changedEmployee": {
            "employeeId": employee["employeeId"], "name": employee["name"],
            "findings": [item for item in detection["findings"] if item["employeeId"] == employee["employeeId"]],
        } if employee else None}

    def record_review(self, definition, case, result, elapsed):
        from runtime.execution import record
        return record(definition["domain_name"], definition, "Review payroll anomaly", {"payrunId": case.payrun_id},
                      {"reply": result["summary"], "answeredBy": "anomaly-investigation", "analysis": result.get("analysis"),
                       "metrics": result.get("metrics")}, elapsed, "anomaly-review", case.snapshot["context"])


class PayrollInvestigator:
    def investigate(self, definition, context, detection, *, model, tools):
        from ..investigation import investigate
        return investigate(definition, context, detection, model=model, tools=tools)
