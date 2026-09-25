#!/usr/bin/env bash
# Build multi-arch (amd64 + arm64) images and push them to GHCR.
# Tags each image with the current git short SHA and with "latest".
#
# Requires: docker login ghcr.io with a token that has the write:packages scope.
set -euo pipefail

cd "$(dirname "$0")"

REGISTRY=ghcr.io/tri-hackathon-inc
SHA=$(git rev-parse --short HEAD)

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Warning: uncommitted changes; the images will not match commit $SHA." >&2
fi

# Run Bake from docker/ so context '..' resolves to the repository root.
# Build sections come from docker-compose.yaml: backend (gRPC + GraphQL + webhook), UI, and the
# temporary TriNet mock API and UI. The db service uses the public mysql image.
for tag in "$SHA" latest; do
  echo "==> Pushing tag: $tag"
  docker buildx bake \
    -f docker-compose.yaml \
    --set "backend.tags=$REGISTRY/payroll-agent-backend:$tag" \
    --set "ui.tags=$REGISTRY/payroll-agent-ui:$tag" \
    --set "trinet-mock.tags=$REGISTRY/payroll-agent-trinet-mock:$tag" \
    --set "trinet-ui.tags=$REGISTRY/payroll-agent-trinet-ui:$tag" \
    --set '*.platform=linux/amd64,linux/arm64' \
    --push
done
