# Editable template configuration

These JSON files are the source of truth for the template catalog. The loader reads
them directly; no API server, database, or seeding is needed.

```text
templates/
  anomaly-detection.json
  summarizer.json
  general-query.json
  failure-investigation.json
  services.json
  Model_config/
    poc-demo.json
    local-open-source.json
```

Each template has `id`, `name`, `description`, `version`, and an out-of-the-box
`config`. To add another use case, copy a template JSON file, choose a unique ID,
change the defaults, and save it in this directory. Increment `version` when
changing a published template. Files must be valid JSON (no comments).

| Template config field | Meaning |
| --- | --- |
| `description`, `instructions`, `questions` | Agent intent, prompt, and starting questions |
| `domain` | Domain shared with its selected services |
| `model` | ID from a file in `Model_config/` |
| `service` | Service to expose/attach this agent to |
| `page` | Page attachment label |
| `attached_services` | Service IDs supplying context or tools |
| `capabilities.alerts` | Enabled flag and info/warning/critical severity |
| `capabilities.webhooks` | Enabled flag and HTTPS destination |
| `created_by`, `roles` | Plain metadata; no authentication or access checks |

`Model_config/` contains one file per model. `poc-demo` is usable for configuration
without a live model. To configure a real deployment, edit `local-open-source.json`:
set your model ID/provider/parameters and enable it. `endpoint_env` and
`credential_env` name environment variables for a future runtime integration.
They never contain raw credentials. Disabled models are listed for transparency
but cannot be referenced as an enabled template default.

`services.json` defines service IDs, domain, HTTP method, path, and `base_url_env`.
For example, attaching `payrun-history` declares a GET to the base URL referenced
by `PAYRUN_API_BASE_URL` plus `/payruns/history`. Path placeholders such as
`{employee_id}` describe runtime inputs; this POC does not resolve or call them.

Example environment names for your deployment:

```text
PAYRUN_API_BASE_URL
EMPLOYEE_API_BASE_URL
DIAGNOSTICS_API_BASE_URL
LOCAL_MODEL_BASE_URL
LOCAL_MODEL_API_KEY
```

The loader returns file contents, not environment variable values. Keep credentials
out of these files. All included service routes are examples to replace with your
actual service contracts. `enabled` means selectable configuration, not a successful
connectivity check.

File changes are reflected the next time you load or validate the catalog. This step only defines
reusable templates; there is no agent creation, persistence, or execution.

You can point `TEMPLATE_CONFIG_DIR` at another directory with this same structure.
Invalid JSON, duplicate IDs, invalid defaults, or broken model/service references
raise `CatalogError`; the validation command reports the error and exits unsuccessfully.
