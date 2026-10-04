import json
import os
import re


class Pseudonymizer:
    def __init__(self, context):
        self.aliases = list(dict.fromkeys((line["employeeId"], line["name"]) for run in [context["current"], *context["history"]] for line in run.get("lines", []) if line.get("name") and line.get("employeeId")))
        self.people = {}
        for identity, name in self.aliases:
            self.people.setdefault(identity, name)
        self.enabled = os.getenv("PII_MASKING", "true").lower() != "false"

    def mask(self, text):
        if not self.enabled:
            return text
        surname_ids = {}
        for identity, name in self.aliases:
            surname_ids.setdefault(name.split()[-1].lower(), set()).add(identity)
        for identity, name in sorted(self.aliases, key=lambda item: len(item[1]), reverse=True):
            for value in (identity + " " + name, name):
                text = re.sub(r"(?<!\w)" + re.escape(value) + r"(?!\w)", lambda _: identity, text, flags=re.I)
        for identity, name in self.aliases:
            surname = name.split()[-1]
            if len(surname_ids[surname.lower()]) == 1:
                text = re.sub(r"(?<!\w)" + re.escape(surname) + r"(?!\w)", lambda _: identity, text, flags=re.I)
        return text

    def restore(self, text):
        if not self.enabled:
            return text
        for identity, name in self.people.items():
            text = re.sub(r"(?<!\w)" + re.escape(identity) + r"(?!\w)(?! " + re.escape(name) + r")", lambda _: identity + " " + name, text)
        return text

    def restore_json(self, text):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                if isinstance(parsed.get("answer"), str):
                    parsed["answer"] = self.restore(parsed["answer"])
                for finding in parsed.get("findings", []):
                    if isinstance(finding, dict):
                        for key in ("explanation", "reviewAction"):
                            if isinstance(finding.get(key), str):
                                finding[key] = self.restore(finding[key])
            return json.dumps(parsed)
        except (ValueError, TypeError):
            return text
