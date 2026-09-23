"""Load and validate editable template files without an API or database."""

import json
import re

from django.conf import settings


class CatalogError(Exception):
    pass


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
                    for field in ("endpoint_env", "credential_env"):
                        value = entry.get(field, "")
                        if not isinstance(value, str) or (
                            value and not re.fullmatch(r"[A-Z_][A-Z0-9_]*", value)
                        ):
                            raise ValueError(
                                f"{field} must be an environment variable name."
                            )
                if name == "services":
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
        from .configuration import validate_config

        for template in templates:
            if type(template.get("version")) is not int or template["version"] < 1:
                raise ValueError("Template version must be a positive integer.")
            if not isinstance(template.get("description"), str):
                raise ValueError("Template description must be text.")
            validate_config(template.get("config"), catalogs)
        return catalogs
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise CatalogError(f"Invalid template catalog: {error}") from error
