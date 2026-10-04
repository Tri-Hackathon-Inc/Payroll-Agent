"""Transient draft checks owned by the anomaly agent; no inference or persistence."""
from copy import deepcopy
from runtime.common import RuntimeFailure, now_iso, numeric
from runtime.payroll import load_context
from .logic import PayrollAnomalyDetector


def preview(body, *, load=load_context):
    if not isinstance(body, dict) or not all(isinstance(body.get(k), str) and body[k] for k in ("payrunId", "lineId")):
        raise RuntimeFailure("A payrun and payment line are required.", 400)
    context = deepcopy(load(body))
    current = context["current"]
    if current["status"] != "PENDING_APPROVAL":
        raise RuntimeFailure("Completed payroll cannot be edited.", 409)
    if body.get("expectedVersion") != current.get("version"):
        raise RuntimeFailure("This payroll has changed. Reload it before checking edits.", 409)
    line = next((line for line in current["lines"] if line.get("lineId") == body["lineId"]), None)
    if not line:
        raise RuntimeFailure("The payment line is not in this payrun.", 404)
    changes = body.get("changes")
    allowed = {"hours": {"regular", "overtime"}, "earnings": {"bonus", "reimbursement"}, "deductions": {"health", "garnishment"}, "paymentMethod": None}
    if not isinstance(changes, dict) or not changes or set(changes) - set(allowed):
        raise RuntimeFailure("Supply editable payroll fields only.", 400)
    derived_pending = False
    for group, values in changes.items():
        if group == "paymentMethod":
            if values not in ("Direct Deposit", "Live Check"):
                raise RuntimeFailure("Invalid payment method.", 400)
            line[group] = values
            continue
        if not isinstance(values, dict) or not values or set(values) - allowed[group]:
            raise RuntimeFailure("Invalid draft payroll fields.", 400)
        if group == "hours" and line.get("payType") != "hourly":
            raise RuntimeFailure("Hours cannot be edited on a salaried payment.", 400)
        for key, value in values.items():
            maximum = 200 if group == "hours" else 1000000
            if not numeric(value) or not 0 <= value <= maximum:
                raise RuntimeFailure(f"Enter a valid {group}.{key} from 0 to {maximum}.", 400)
            line[group][key] = value
        derived_pending = True
    if derived_pending:
        # Payroll owns tax/retirement calculations. Never compare stale totals as if
        # they had already been recalculated for a draft input.
        line["gross"] = line["net"] = None
        line["deductions"]["retirement401k"] = None
    detection = PayrollAnomalyDetector().detect(context, line["employeeId"])
    evidence = detection["analysis"]
    return {"type": "preview", "saved": False, "payrunId": current["id"], "version": current["version"], "lineId": line["lineId"], "employeeId": line["employeeId"],
            "checkedAt": now_iso(), "decision": detection["decision"], "analysis": evidence, "findings": detection["findings"], "derivedAmountsPending": derived_pending}

