# Docker setup

Run Compose commands from the repository root. This keeps root `.env` loading
consistent; build contexts and development mounts are configured relative to
the Compose files in this directory.

```sh
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
docker compose -f docker/docker-compose.yaml ps
```

Open [Agent Studio](http://localhost:5173/ai_studio/) or
[GraphQL Sandbox](http://localhost:4000/). Omit the service list to start the
optional TriNet payroll API and UI as well.

When credentials are stored in `backend/.env`, include `--env-file backend/.env`
after `-f docker/docker-compose.yaml` on startup/recreation commands. Compose does
not read that file automatically. If root `.env` also contains database settings,
use `--env-file .env --env-file backend/.env` to load both without changing the
initialized database credentials. Never print resolved Compose configuration
with credentials; use `config --quiet` for validation.

The core stack has five services: UI, backend, MySQL, Redis and PostgreSQL with
pgvector. Redis and PostgreSQL start automatically as backend dependencies.
The full demo adds two TriNet services. Redis holds short conversations in memory
with a default 30-minute inactivity timeout and no disk persistence. PostgreSQL
retains semantic payroll documents and their embeddings in `vector_data`.
The backend downloads local embedding weights on first use into `embedding_cache`.
Set `VECTOR_DB_PASSWORD` before initializing PostgreSQL; preserve it on later starts.

| File | Purpose |
| --- | --- |
| `Dockerfile` | Builds `backend`, `ui`, `trinet-mock`, and `trinet-ui` from the repository root context |
| `Dockerfile.dockerignore` | Shared build exclusions, including dependencies, `.env` files, and local databases |
| `docker-compose.yaml` | Main local stack; project name `payroll-local` |
| `docker-compose.local.yaml` | Explicit local variant extending the main stack |
| `docker-compose.dev.yaml` | Source bind mounts for development |
| `docker-compose.test.yaml` | Isolated core stack with temporary MySQL, Redis and PostgreSQL data and no published ports |
| `docker-entrypoint.test.sh` | Helper to migrate and sync before running a test command |
| `publish-images.sh` | Builds multi-platform images and pushes them to GHCR when explicitly invoked |

The ignore file uses Docker's
[Dockerfile-specific naming convention](https://docs.docker.com/build/concepts/context/#filename-and-location),
so no `.dockerignore` or Dockerfile is needed inside either UI folder.

Development mode:

```sh
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.dev.yaml up --build -d --wait db backend ui
```

Validate all variants without starting containers:

```sh
docker compose -f docker/docker-compose.yaml config --quiet
docker compose -f docker/docker-compose.local.yaml config --quiet
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.dev.yaml config --quiet
docker compose -f docker/docker-compose.test.yaml config --quiet
```

The test stack has its own project name, `payroll-api-test`:

```sh
docker compose -f docker/docker-compose.test.yaml up --build -d --wait
docker compose -f docker/docker-compose.test.yaml down
```

To build a single target directly from the repository root:

```sh
docker build -f docker/Dockerfile --target ui -t payroll-local-ui .
```

Stop the local stack with `docker compose -f docker/docker-compose.yaml down`.
Named volumes `mysql_data`, `trinet_data`, `vector_data` and `embedding_cache` retain data; keep the
project and volume names unchanged and do not use `down -v` to preserve them.
See the [root README](../README.md) for logs, restart commands, and configuration.
