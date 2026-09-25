# Container setup

Use Docker below, or follow [macOS with Podman](#macos-with-podman). Both use the
same Compose file and Dockerfile; all container assets stay in this directory.

## Docker

Run Compose commands from the repository root. This keeps root `.env` loading
consistent; build contexts and development mounts are configured relative to
the Compose files in this directory.

```sh
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
docker compose -f docker/docker-compose.yaml ps
```

Open [Agent Studio](http://localhost:5173/ai_studio/) or
[GraphQL Sandbox](http://localhost:4000/). Omit the service list to start the
optional TriNet payroll API, UI and incident evidence capture as well.

When credentials are stored in `backend/.env`, include `--env-file backend/.env`
after `-f docker/docker-compose.yaml` on startup/recreation commands. Compose does
not read that file automatically. If root `.env` also contains database settings,
use `--env-file .env --env-file backend/.env` to load both without changing the
initialized database credentials. Never print resolved Compose configuration
with credentials; use `config --quiet` for validation.

The core stack has five services: UI, backend, MySQL, Redis and PostgreSQL with
pgvector. Redis and PostgreSQL start automatically as backend dependencies.
The full demo adds two TriNet services and `evidence-capture` (eight services total).
Redis holds short conversations in memory
with a default 30-minute inactivity timeout and no disk persistence. PostgreSQL
retains semantic payroll documents and their embeddings in `vector_data`.
The backend downloads local embedding weights on first use into `embedding_cache`.
Set `VECTOR_DB_PASSWORD` before initializing PostgreSQL; preserve it on later starts.

| File | Purpose |
| --- | --- |
| `Dockerfile` | Builds `backend`, `ui`, `trinet-mock`, `trinet-ui` and `evidence-capture` from the repository root context |
| `Dockerfile.dockerignore` | Shared build exclusions, including dependencies, `.env` files, and local databases |
| `docker-compose.yaml` | Main local stack; project name `payroll-local` |
| `docker-compose.local.yaml` | Explicit local variant extending the main stack |
| `docker-compose.dev.yaml` | Source bind mounts for development |
| `docker-compose.test.yaml` | Isolated core stack with temporary MySQL, Redis and PostgreSQL data and no published ports |
| `docker-entrypoint.test.sh` | Helper to migrate and sync before running a test command |
| `podman.sh` | Runs the shared local stack with Podman, environment files and explicit build exclusions |
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

## macOS with Podman

Podman runs Linux containers in a VM on macOS. With Homebrew installed, install
Podman and its native Compose provider, then initialize the VM once:

```sh
brew install podman podman-compose
podman machine init --cpus 4 --memory 8192 --disk-size 50
podman machine start
podman info
```

The resource values are a starting allocation for this stack: 4 CPUs, 8 GiB RAM
and 50 GiB disk. Adjust them to your Mac's capacity. If you already have a Podman
machine, use `podman machine list` and start that machine instead of initializing
another one. See the [Podman installation guide](https://podman.io/docs/installation)
for the official macOS installer alternative and
[machine options](https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html).

From the **repository root**, build and start all eight services:

```sh
bash docker/podman.sh up --build -d
bash docker/podman.sh ps
```

Wait for the health checks to show `healthy`, then open
[Agent Studio](http://localhost:5173/ai_studio/) or the
[TriNet payrun](http://localhost:5174/trinet/?domain=payroll-services&payrun=PR-2026-09-B).
The backend is at `http://localhost:4000/`; the payroll API is at
`http://localhost:4100/`. The first build and embedding model download can take
several minutes. To start only the five core services, use:

```sh
bash docker/podman.sh up --build -d db backend ui
```

The launcher loads root `.env` followed by `backend/.env` when they exist, so
your `HF_TOKEN` and database settings are retained across starts. Later files
override earlier values; exported shell variables take precedence. Keep existing
database credentials when reusing volumes. No environment file is required for
the local defaults; real model calls need the provider token.

The launcher selects `podman-compose` explicitly because
[`podman compose`](https://docs.podman.io/en/latest/markdown/podman-compose.1.html)
delegates to an external provider. It passes
[`--ignorefile`](https://docs.podman.io/en/latest/markdown/podman-build.1.html#ignorefile)
so Podman applies `docker/Dockerfile.dockerignore` to every build. Image references
include `docker.io` to avoid short-name registry prompts. Use the launcher for
builds and recreation commands to retain these settings.

Manage the running stack:

```sh
# Check service health and recent logs.
bash docker/podman.sh ps
bash docker/podman.sh logs --tail=100 backend ui db redis vector-db

# Apply changes to backend/.env without restarting the databases.
bash docker/podman.sh up -d --force-recreate --no-deps backend

# Preload historical payroll documents into PostgreSQL/pgvector.
bash docker/podman.sh exec backend node graphql/rag/ingest-history.js --domain payroll-services --service payrun

# Stop containers; resume them later with up -d.
bash docker/podman.sh stop
bash docker/podman.sh up -d

# Remove this project's containers and network, keeping named volumes.
bash docker/podman.sh down
```

After stopping the stack, `podman machine stop` shuts down the VM. On the next
session, run `podman machine start` followed by `bash docker/podman.sh up -d`.
Keep the machine and named volumes to preserve saved agents, payroll history
and cached embeddings; do not use `down -v` or delete the machine for a routine
restart. Redis conversations remain temporary.

Docker and Podman have separate containers and volumes; existing Docker data
does not transfer automatically. If this stack is already running in Docker,
stop it before starting Podman to free ports 4000, 4100, 5173, 5174 and 50051:

```sh
docker compose -f docker/docker-compose.yaml stop
```

If Podman cannot connect, check `podman machine list` and start the selected VM.
For startup failures, inspect `ps` and service logs above. These commands use the
main local Compose file; the Docker test workflow above remains separate.
