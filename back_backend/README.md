# Template authoring POC

Templates are editable JSON files. For local API testing, the gRPC servicer reads
a synchronized SQLite catalog and a temporary Apollo server exposes GraphQL.
There are no REST endpoints, agent creation APIs, authentication, or agent execution.

## Setup and validation

From the repository root, using Python 3.11+:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.lock
python backend/manage.py validate_templates
```

To inspect the complete validated catalog:

```bash
python backend/manage.py validate_templates --dump
```

Or run `docker compose run --build --rm backend`. This validates files and exits;
it does not start an HTTP server.

For the temporary API stack, run `docker compose -f docker-compose.test.yaml up --build`
from the repository root, then open <http://localhost:4000/>. The backend applies
migrations and synchronizes the template files before starting gRPC. The database
is temporary and resets when the backend container stops. After editing template
JSON, restart the backend to synchronize it again. See the
[Apollo setup and queries](graphql/README.md#temporary-apollo-server).

## Build a template

1. Copy a JSON file from `templates/` and assign a unique ID.
2. Set its name, version, description, instructions, and questions.
3. Set out-of-the-box alerts, webhooks, and service attachment defaults.
4. Reference model IDs from `templates/Model_config/` and service IDs from `templates/services.json`.
5. Run `validate_templates` to check the result.

Included use cases: Anomaly Detection, Summarizer, General Query, and Failure
Investigation. The demo model and service definitions are configuration examples;
no external calls are made. See the [configuration guide](templates/README.md).

`registry.catalog.load_catalog()` is a local Python loader returning `templates`,
`model_configs`, and `services`. Invalid files raise `CatalogError`; the management
command exits with an error. Files are reread on each invocation.

## Checks

```bash
python backend/manage.py check
python backend/manage.py test registry
```

Tests cover defaults, new/edited templates, invalid files, CLI validation, and the
absence of HTTP routes. Old database files and archived source are preserved but unused.
