#!/usr/bin/env bash
# Compose for the shared stack; fall back to Podman when Docker is not installed.
# The settings files are loaded on every invocation, like
# podman.sh. Without --env-file, Compose looks for infra/docker/.env, so model keys in the root .env or
# backend/.env silently stay empty and every model call fails.
#   bash infra/docker/compose.sh up --build -d --wait
#   bash infra/docker/compose.sh ps
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"

if ! command -v docker >/dev/null 2>&1; then
  exec bash "$repo_dir/infra/docker/podman.sh" "$@"
fi

compose_args=(-f infra/docker/docker-compose.yaml)
# Do not source these files as shell scripts or print their contents.
for env_file in .env backend/.env; do
  if [[ -f "$env_file" ]]; then
    compose_args+=(--env-file "$env_file")
  fi
done

if [[ $# -eq 0 ]]; then
  set -- --help
fi

exec docker compose "${compose_args[@]}" "$@"
