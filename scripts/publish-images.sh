#!/usr/bin/env bash
# Build multi-arch (amd64 + arm64) images and push them to GHCR.
# Tags each image with the current git short SHA and with "latest".
#
# Requires: docker login ghcr.io with a token that has the write:packages scope.
set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY=ghcr.io/tri-hackathon-inc
SHA=$(git rev-parse --short HEAD)

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Warning: uncommitted changes; the images will not match commit $SHA." >&2
fi

# The build sections live in docker-compose.dev.yaml, so use it together with the
# base file and set the tags explicitly (the dev file's :dev image name is overridden).
for tag in "$SHA" latest; do
  echo "==> Pushing tag: $tag"
  docker buildx bake \
    -f docker-compose.yaml -f docker-compose.dev.yaml \
    --set "backend.tags=$REGISTRY/payroll-agent-backend:$tag" \
    --set "ui.tags=$REGISTRY/payroll-agent-ui:$tag" \
    --set '*.platform=linux/amd64,linux/arm64' \
    --push
done
