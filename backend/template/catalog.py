"""Load and validate editable template files without an API or database."""

import json
import re

from django.conf import settings


class CatalogError(Exception):
    pass


MODEL_LICENSES = ("open-source", "commercial", "demo")


def validate_model_details(details):
    """Optional display metadata for the model library."""
    if not isinstance(details, dict):
        raise ValueError("Model details must be an object.")
    if "license" in details and details["license"] not in MODEL_LICENSES:
        raise ValueError(f"Model license must be one of {', '.join(MODEL_LICENSES)}.")
    for field in ("description", "context_window"):
        if field in details and not isinstance(details[field], str):
            raise ValueError(f"Model {field} must be text.")
    for field in ("strengths", "best_for"):
        value = details.get(field, [])
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise ValueError(f"Model {field} must be a list of text.")
    benchmarks = details.get("benchmarks", [])
    if not isinstance(benchmarks, list):
        raise ValueError("Model benchmarks must be a list.")
    for benchmark in benchmarks:
        # Published scores only, each traceable to its source.
        if (
            not isinstance(benchmark, dict)
            or not isinstance(benchmark.get("name"), str)
            or type(benchmark.get("score")) not in (int, float)
            or not isinstance(benchmark.get("source"), str)
            or not benchmark["source"].startswith("https://")
        ):
            raise ValueError("Benchmarks need a name, a numeric score, and an https source.")


def validate_supported_models(template, model_configs):
    supported = template.get("models", [])
    enabled = {item["id"] for item in model_configs if item["enabled"]}
    if not isinstance(supported, list) or not all(isinstance(item, str) for item in supported):
        raise ValueError("Template models must be a list of model IDs.")
    if any(item not in enabled for item in supported):
        raise ValueError("Template models must reference enabled model configurations.")
    if supported and template["config"]["model"] not in supported:
        raise ValueError("The template's default model must be one of its models.")


def load_catalog():
    root = settings.TEMPLATE_CONFIG_DIR
    try:
        templates = [
            json.loads(path.read_text())
            for path in sorted(root.glob("*.json"))
            if path.name != "services.json"
        ]
        models = [
            json.loads(path.read_text())
            for path in sorted((root / "Model_config").glob("*.json"))
        ]
        services = json.loads((root / "services.json").read_text())
        catalogs = {
            "templates": templates,
            "model_configs": models,
            "services": services,
        }
        for name, entries in catalogs.items():
            if not isinstance(entries, list) or not entries:
                raise ValueError(f"{name} must be a nonempty array of configurations.")
            ids = set()
            for entry in entries:
                if (
                    not isinstance(entry, dict)
                    or not isinstance(entry.get("id"), str)
                    or not re.fullmatch(r"[a-zA-Z0-9_-]+", entry["id"])
                ):
                    raise ValueError(f"Invalid configuration ID in {name}.")
                if entry["id"] in ids:
                    raise ValueError(f'Duplicate ID {entry["id"]} in {name}.')
                ids.add(entry["id"])
                if not isinstance(entry.get("name"), str) or not entry["name"].strip():
                    raise ValueError(f"A name is required in {name}.")
                if name != "templates" and type(entry.get("enabled")) is not bool:
                    raise ValueError(f"An enabled boolean is required in {name}.")
                if name == "model_configs":
                    if any(
                        not isinstance(entry.get(field), str)
                        or not entry[field].strip()
                        for field in ("provider", "model_id")
                    ):
                        raise ValueError(
                            "Models require provider and model_id strings."
                        )
                    if not isinstance(entry.get("parameters"), dict):
                        raise ValueError("Model parameters must be an object.")
                    validate_model_details(entry.get("details", {}))
                    for field in ("endpoint_env", "credential_env"):
                        value = entry.get(field, "")
                        if not isinstance(value, str) or (
                            value and not re.fullmatch(r"[A-Z_][A-Z0-9_]*", value)
                        ):
                            raise ValueError(
                                f"{field} must be an environment variable name."
                            )
                if name == "services":
                    operations = entry.get("operations", [])
                    if not isinstance(operations, list):
                        raise ValueError("Service operations must be a list.")
                    seen = set()
                    for operation in operations:
                        if not isinstance(operation, dict) or operation.get("method") not in ("GET", "POST", "PUT", "PATCH", "DELETE") or operation.get("access") not in ("R", "W") or not isinstance(operation.get("path"), str) or not operation["path"].startswith("/"):
                            raise ValueError("Each API operation needs a method, path and R/W access.")
                        key = (operation["method"], operation["path"])
                        if key in seen:
                            raise ValueError("Duplicate service operation.")
                        seen.add(key)
                    if (
                        not isinstance(entry.get("domain"), str)
                        or not entry["domain"].strip()
                    ):
                        raise ValueError("Services require a domain.")
                    if entry.get("method") not in (
                        "GET",
                        "POST",
                        "PUT",
                        "PATCH",
                        "DELETE",
                    ):
                        raise ValueError("Invalid service HTTP method.")
                    if not isinstance(entry.get("path"), str) or not entry[
                        "path"
                    ].startswith("/"):
                        raise ValueError("Service path must begin with /.")
                    if not isinstance(
                        entry.get("base_url_env"), str
                    ) or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", entry["base_url_env"]):
                        raise ValueError(
                            "base_url_env must be an environment variable name."
                        )
        from template.configuration import validate_config

        for template in templates:
            if type(template.get("version")) is not int or template["version"] < 1:
                raise ValueError("Template version must be a positive integer.")
            if not isinstance(template.get("description"), str):
                raise ValueError("Template description must be text.")
            validate_config(template.get("config"), catalogs)
            validate_supported_models(template, catalogs["model_configs"])
        return catalogs
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise CatalogError(f"Invalid template catalog: {error}") from error
