#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

cluster=payroll-local
context=kind-payroll-local
provider="${KIND_EXPERIMENTAL_PROVIDER:-docker}"
image_archive=''
trap 'if [[ -n "$image_archive" ]]; then rm -f -- "$image_archive"; fi' EXIT
compose_args=(-p payroll-k8s -f docker/docker-compose.yaml)
for env_file in .env backend/.env; do
  if [[ -f "$env_file" ]]; then
    compose_args+=(--env-file "$env_file")
  fi
done

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s. See k8s/README.md.\n' "$1" >&2
    exit 1
  fi
}

resolve_compose() {
  if docker compose version >/dev/null 2>&1; then
    compose_command=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    compose_command=(docker-compose)
  else
    printf 'Install Docker Compose v2 (docker compose or docker-compose).\n' >&2
    exit 1
  fi
}

apply_stack() {
  "${compose_command[@]}" "${compose_args[@]}" config --format json \
    | node k8s/render.mjs \
    | kubectl --context "$context" apply --server-side --field-manager=payroll-local -f -
}

wait_stack() {
  for service in redis vector-db db backend ui trinet-mock trinet-ui evidence-capture; do
    kubectl --context "$context" -n payroll rollout status "deployment/${service}" --timeout=900s
  done
}

case "${1:-help}" in
  up)
    case "$provider" in
      docker|podman) ;;
      *) printf 'Unsupported container provider: %s\n' "$provider" >&2; exit 1 ;;
    esac
    for executable in "$provider" kind kubectl node; do require "$executable"; done
    "$provider" info >/dev/null
    resolve_compose
    export KIND_EXPERIMENTAL_PROVIDER="$provider"
    if ! kind get clusters | grep -Fxq "$cluster"; then
      kind create cluster --name "$cluster" --config k8s/kind.yaml --wait 120s
    fi
    build_args=(-f docker/Dockerfile)
    if [[ "$provider" == podman ]]; then
      build_args+=(--ignorefile docker/Dockerfile.dockerignore)
    fi
    for service in backend ui trinet-mock trinet-ui evidence-capture; do
      "$provider" build "${build_args[@]}" --target "$service" -t "docker.io/payroll/${service}:local" .
      if [[ "$provider" == podman ]]; then
        image_archive="$(mktemp "${TMPDIR:-/tmp}/payroll-kind-image.XXXXXX")"
        podman save --format docker-archive -o "$image_archive" "docker.io/payroll/${service}:local"
        kind load image-archive "$image_archive" --name "$cluster"
        rm -f -- "$image_archive"
        image_archive=''
      else
        kind load docker-image "docker.io/payroll/${service}:local" --name "$cluster"
      fi
    done
    apply_stack
    kubectl --context "$context" -n payroll rollout restart deployment/backend deployment/ui \
      deployment/trinet-mock deployment/trinet-ui deployment/evidence-capture
    wait_stack
    printf '\nAgent Studio: http://localhost:5173/ai_studio/\nTriNet: http://localhost:5174/trinet/\nBackend: http://localhost:4000/\n'
    ;;
  apply)
    for executable in kubectl node; do require "$executable"; done
    resolve_compose
    apply_stack
    kubectl --context "$context" -n payroll rollout restart deployment
    wait_stack
    ;;
  status)
    require kubectl
    kubectl --context "$context" -n payroll get pods,services,pvc
    ;;
  logs)
    require kubectl
    kubectl --context "$context" -n payroll logs "deployment/${2:-backend}" --all-containers --tail=100 -f
    ;;
  down)
    require kubectl
    kubectl --context "$context" -n payroll scale deployment --all --replicas=0
    printf 'Workloads stopped; cluster and persistent volumes retained. Use up to restart.\n'
    ;;
  delete)
    if [[ "${2:-}" != '--confirm-data-loss' ]]; then
      printf 'Deleting the cluster removes its databases and artifacts. Run: bash k8s/local.sh delete --confirm-data-loss\n' >&2
      exit 1
    fi
    require kind
    KIND_EXPERIMENTAL_PROVIDER="$provider" kind delete cluster --name "$cluster"
    ;;
  help|--help|-h)
    printf 'Usage: bash k8s/local.sh {up|apply|status|logs [service]|down|delete --confirm-data-loss}\n'
    ;;
  *)
    printf 'Unknown command: %s\n' "$1" >&2
    exit 1
    ;;
esac