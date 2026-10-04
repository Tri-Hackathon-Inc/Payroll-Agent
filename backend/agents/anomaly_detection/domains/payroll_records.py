"""Map payroll source data onto the same measurement contract used by other domains."""
from runtime.common import RuntimeFailure, digest, total, valid_date
from runtime.payroll import groups
from ..records import validate_record_event


MEASUREMENTS = (
    "earnings.regular", "earnings.overtime", "earnings.bonus", "earnings.reimbursement",
    "taxes.federal", "taxes.state", "taxes.socialSecurity", "taxes.medicare", "gross", "net",
    "hours.regular", "hours.overtime", "deductions.health", "deductions.retirement401k", "deductions.garnishment",
)


def payrun_events(run, domain_name):
    """Produce employee and company peer features without recomputing raw history."""
    if not valid_date(run.get("payDate")) or not run.get("company") or not run.get("currency") or not run.get("frequency"):
        raise RuntimeFailure("Payroll measurements require pay date, company, currency and frequency.", 400)
    events = []
    for employee, lines in groups(run["lines"]).items():
        pay_types = {line.get("payType") for line in lines}
        if len(pay_types) != 1 or None in pay_types:
            raise RuntimeFailure("All lines for an employee must have one pay type.", 400)
        dimensions = {"frequency": run["frequency"], "payType": next(iter(pay_types))}
        measurements = []
        for path in MEASUREMENTS:
            for cohort in ({**dimensions, "employeeId": employee}, dimensions):
                measurements.append({"name": path, "value": total(lines, [path]),
                                     "unit": "hours" if path.startswith("hours.") else run["currency"], "dimensions": cohort})
        # Provider company names may contain spaces; use a stable digest for the
        # tenant key rather than exposing a display name as a grouping identifier.
        identity = f"{run['id']}:{employee}"
        events.append(validate_record_event({
            "type": "anomaly.recorded", "domainName": domain_name, "tenant": digest([run["company"]]),
            "entityType": "paycheck", "entityId": identity if len(identity) <= 100 else digest([run["id"], employee]),
            "version": run.get("version"), "occurredAt": run["payDate"] + "T00:00:00Z",
            "finalized": run.get("status") == "COMPLETED", "measurements": measurements,
        }))
    return events
