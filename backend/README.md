# Business agents backend

A gRPC service with GraphQL adapters for listing templates, reading configurable
template properties, creating/updating agents, listing businesses, and listing
agents within a business. There are no REST endpoints or Django HTTP routes.

See [AGENTS.md](AGENTS.md) for the backend overview and flow diagrams, and
[graphql/README.md](graphql/README.md) for GraphQL request examples.

## Local settings

All Django server settings and the Apollo host live in `backend/local_server/`:

```text
local_server/
  __init__.py
  studio/
    __init__.py
    settings.py
    asgi.py
    wsgi.py
  apollo.js
  apollo-settings.json
```

This folder is ignored by Git and excluded from Docker build contexts. Docker
files remain outside it. Each checkout must supply its own local folder; it will
not be available from a clone. Django defaults to `local_server.studio.settings`,
or uses an explicit `DJANGO_SETTINGS_MODULE`. The integration tests require
these settings too. Apollo defaults are in `apollo-settings.json`; `GRPC_ADDRESS`,
`HOST`, and `PORT` override them.

## Setup

With local settings provisioned, run from the repository root using Python 3.11+:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.lock
python backend/manage.py validate_templates
python backend/manage.py migrate
python backend/manage.py sync_templates
python backend/manage.py rungrpc
```

Migrations seed `payroll-services` (Payroll Services). The gRPC server defaults to
`127.0.0.1:50051`. `DATABASE_PATH` controls the SQLite file used for the catalog,
businesses, and agents. `TEMPLATE_CONFIG_DIR` controls the source catalog directory.

Template JSON remains authoritative for reusable defaults. Saved agents persist
independently, retaining the user's effective configuration and source template
version. See the [template authoring guide](templates/README.md).

For the temporary Apollo/gRPC stack:

```bash
docker compose -f docker-compose.test.yaml up --build
```

Open <http://localhost:4000/> for GraphQL queries and mutations. This test stack
uses a temporary database discarded when the backend container stops. Restart
the backend after template edits to synchronize again; rebuild after code edits.
The default backend Docker target only validates templates and exits; the
`api-test` target serves gRPC. The test stack mounts `backend/local_server/`
read-only into both containers at runtime. Settings are not baked into images.
To run the validation image directly, also mount the local settings directory:

```bash
docker build -t payroll-backend-validator backend
docker run --rm --mount type=bind,source="$PWD/backend/local_server",target=/app/local_server,readonly payroll-backend-validator
```

## Checks

```bash
python backend/manage.py check
python backend/manage.py test registry
cd backend/graphql
npm ci
npm test
```

The GraphQL integration test launches a real gRPC service against a temporary
SQLite database. Set `PYTHON` if your interpreter is not `.venv/bin/python` at the
repository root. The Apollo host requires Node 22+.

This backend stores configuration; it does not execute agents, call external
APIs/models, or deliver alerts/webhooks. Authentication and authorization are
not implemented.
