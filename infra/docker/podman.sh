#!/usr/bin/env bash
# Use the shared stack with the native Podman Compose provider.
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"

if ! command -v podman >/dev/null 2>&1; then
  echo "Docker/Podman is missing. Install Podman and native podman-compose; see README. On macOS: brew install podman podman-compose" >&2
  exit 1
fi
if ! command -v podman-compose >/dev/null 2>&1; then
  echo "Native podman-compose is missing from PATH. Install podman-compose 1.6.0 or newer; see README." >&2
  exit 1
fi

# Pin the provider: Docker Compose does not accept --podman-build-args.
export PODMAN_COMPOSE_PROVIDER="$(command -v podman-compose)"

# Podman needs the shared ignore file explicitly; paths resolve from repo_dir.
compose_args=(
  --in-pod=false
  --podman-build-args=--ignorefile=infra/docker/Dockerfile.dockerignore
  -f infra/docker/docker-compose.yaml
)

# Keep deployment settings and model credentials on every invocation. Do not
# source these files as shell scripts or print their contents.
for env_file in .env backend/.env; do
  if [[ -f "$env_file" ]]; then
    compose_args+=(--env-file "$env_file")
  fi
done

if [[ $# -eq 0 ]]; then
  set -- --help
fi

exec podman compose "${compose_args[@]}" "$@"
