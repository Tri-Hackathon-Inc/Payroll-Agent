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

### 2. Run the published images

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

## Development

The frontend is built with React and Vite. The backend uses Django REST Framework and SQLite.

To build from your local source and hot-reload changes, add the dev override file:

```bash
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up --build
```

Local builds are tagged `:dev`, so they never overwrite the published images.

## Publishing images

Log in with a token that has the `write:packages` scope, commit your changes, then run:

```bash
./scripts/publish-images.sh
```

This builds for both Intel and Apple Silicon and pushes each image tagged with the current git short SHA and `latest`.
