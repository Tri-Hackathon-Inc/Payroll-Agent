"""Trusted component factories. Agent JSON selects names, never executable import paths."""
from dataclasses import dataclass
from .domains.payroll import PayrollDomain, PayrollInvestigator
from .features.payroll import PayrollFeatureEnricher
from .features.store import DatabaseFeatureStore, NoFeatureStore
from .logic import PayrollAnomalyDetector
from .tools.payroll import PayrollEvidenceTools
from .domains.records import RecordDomain, RecordEnricher, RecordEvidenceTools, RecordInvestigator
from .scoring import RecordDetector
from .decision import DecisionModelDetector
from .jev import JevDecisionModel


@dataclass(frozen=True)
class DomainProfile:
    category: str | None
    domain: object
    enrichers: dict
    detectors: dict
    investigators: dict
    tools: dict
    defaults: dict
    event_type: str | None = None


PROFILES = {"payroll": DomainProfile(
    category="Payroll", domain=PayrollDomain,
    enrichers={"historical": PayrollFeatureEnricher}, detectors={"historical-policy": PayrollAnomalyDetector},
    investigators={"grounded": PayrollInvestigator}, tools={"payroll-evidence": PayrollEvidenceTools},
    defaults={"enricher": "historical", "detector": "historical-policy", "investigator": "grounded", "tools": "payroll-evidence"},
), "records": DomainProfile(
    category=None, domain=RecordDomain,
    enrichers={"rolling": RecordEnricher}, detectors={"statistics": RecordDetector},
    investigators={"grounded": RecordInvestigator}, tools={"record-evidence": RecordEvidenceTools},
    defaults={"enricher": "rolling", "detector": "statistics", "investigator": "grounded", "tools": "record-evidence"},
    event_type="anomaly.recorded",
)}
FEATURE_STORES = {"database": DatabaseFeatureStore, "none": NoFeatureStore}
DECISION_MODELS = {"jev": JevDecisionModel}


def register_profile(name, profile):
    """Register trusted application code at startup, before workers accept traffic."""
    if not isinstance(name, str) or not name or name in PROFILES or not isinstance(profile, DomainProfile):
        raise ValueError("Register a new name and a DomainProfile.")
    PROFILES[name] = profile


def register_feature_store(name, factory):
    if not isinstance(name, str) or not name or name in FEATURE_STORES or not callable(factory):
        raise ValueError("Register a new feature store name and factory.")
    FEATURE_STORES[name] = factory


def register_decision_model(name, factory):
    """Register a trusted scoring adapter before workers accept requests."""
    if not isinstance(name, str) or not name or name == "none" or name in DECISION_MODELS or not callable(factory):
        raise ValueError("Register a new decision-model name and factory.")
    DECISION_MODELS[name] = factory


def anomaly_settings(config):
    supplied = config.get("anomaly", {})
    allowed = {"profile", "featureStore", "enricher", "detector", "investigator", "tools", "decisionModel"}
    if not isinstance(supplied, dict) or set(supplied) - allowed or any(not isinstance(v, str) for v in supplied.values()):
        raise ValueError("anomaly must contain registered component names only.")
    name = supplied.get("profile", "payroll")
    profile = PROFILES.get(name)
    if profile is None or (profile.category is not None and profile.category != config.get("domain")):
        raise ValueError("Anomaly profile must be registered for the configured domain category.")
    result = {"profile": name, "featureStore": "database", **profile.defaults, **supplied}
    choices = {"featureStore": FEATURE_STORES, "enricher": profile.enrichers, "detector": profile.detectors,
               "investigator": profile.investigators, "tools": profile.tools}
    for key, options in choices.items():
        if result[key] not in options:
            raise ValueError(f"Unknown anomaly {key}: {result[key]}.")
    selected = result.get("decisionModel", "jev" if name in ("payroll", "records") else "none")
    if selected != "none" and selected not in DECISION_MODELS:
        raise ValueError(f"Unknown anomaly decisionModel: {selected}.")
    result["decisionModel"] = selected
    return result


def is_anomaly_agent(definition):
    return definition.get("template_id") == "anomaly-detection" or isinstance(definition.get("config", {}).get("anomaly"), dict)


class AnomalyComponents:
    def __init__(self, config):
        self.settings = anomaly_settings(config)
        profile = PROFILES[self.settings["profile"]]
        self.domain = profile.domain()
        self.enricher = profile.enrichers[self.settings["enricher"]]()
        self.detector = profile.detectors[self.settings["detector"]]()
        selected = self.settings["decisionModel"]
        if selected != "none":
            self.detector = DecisionModelDetector(self.detector, DECISION_MODELS[selected](), selected)
        self.investigator = profile.investigators[self.settings["investigator"]]()
        self.tools = profile.tools[self.settings["tools"]]()
        self.feature_store = FEATURE_STORES[self.settings["featureStore"]]()
