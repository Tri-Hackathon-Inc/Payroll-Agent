# Payroll Agent

A simple agent builder for creating and managing HR, payroll, and time-off assistants.

## Run with Docker

The images are published to GitHub Container Registry, so you don't need Python or Node installed.

### 1. Log in to GHCR (one time)

The packages are private. Create a GitHub personal access token (classic) with the `read:packages` scope, then:

```bash
docker login ghcr.io -u <your-github-username>
```

Paste the token when prompted for a password.

### 2. Configure (optional)

Copy the example settings file. Every value is optional and the defaults work for local development:

```bash
cp .env.example .env
```

`.env` is gitignored. The example turns on `SEED_SAMPLE_AGENTS`, which loads four starter agents into an empty database so everyone starts with the same registry. It never touches a database that already has agents.

### 3. Run the published images

```bash
docker compose pull
docker compose up -d
```

- Agent Studio (templates + registry): http://localhost:5173/ai-studio
- Raw agent list: http://localhost:5173/agents
- API: http://localhost:8000/api/agents/

To run a specific version instead of `latest`, set `IMAGE_TAG` (a git short SHA):

```bash
IMAGE_TAG=5fe9431 docker compose up -d
```

Stop the application with:

```bash
docker compose down
```

Your agents live in a Docker volume (`backend_data`), so they survive `docker compose down` and restarts. To wipe them and start fresh, run `docker compose down -v`.

## Development

The frontend is built with React and Vite. The backend uses Django REST Framework and SQLite.

To build from your local source and hot-reload changes, add the dev override file:

```bash
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up --build
```

Local builds are tagged `:dev`, so they never overwrite the published images. Dev mode uses the same `backend_data` volume for the database, so a `backend/db.sqlite3` file from earlier local runs is no longer read.

## GraphQL and mock data

The UI talks to a single GraphQL endpoint, `/graphql`, and no longer hardcodes templates, domains, models or tools.

- `ui-payroll-agent/graphql/schema.graphql` is the contract. The backend should implement this schema.
- `ui-payroll-agent/src/graphql/operations.js` holds the queries and the `saveAgent` mutation the UI runs.
- `ui-payroll-agent/mock/data.json` is the mock data (domains, templates, models, tools, starter agents).

By default (`GRAPHQL_MODE=mock`) the Vite dev server answers `/graphql` from `mock/data.json`, so the UI works with no backend. Agents you save in this mode are kept in memory and reset when the UI container restarts. They are not written to the Django database.

To use a real backend instead, set `GRAPHQL_MODE=backend` in `.env`. Vite then proxies `/graphql` to `API_PROXY_TARGET` (`http://backend:8000` in Docker).

If you rebuild the dev image and see `Cannot find package 'graphql'`, the `ui_node_modules` volume is stale. Run `docker compose -f docker-compose.yaml -f docker-compose.dev.yaml down -v` once, then start again.

## Publishing images

Log in with a token that has the `write:packages` scope, commit your changes, then run:

```bash
./scripts/publish-images.sh
```

This builds for both Intel and Apple Silicon and pushes each image tagged with the current git short SHA and `latest`.
