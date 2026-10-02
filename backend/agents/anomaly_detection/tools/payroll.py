"""Available payroll evidence. Unconnected employee/tax/policy/audit APIs are not invented."""


class PayrollEvidenceTools:
    def collect(self, context, detection):
        from ..investigation import evidence_sources
        return evidence_sources(context, detection)
