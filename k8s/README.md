# Local Kubernetes

Run the existing payroll stack in a single-node **kind** Kubernetes cluster,
instead of running its services directly with Compose. The cluster still runs
inside Docker or Podman on your laptop. A remote cluster is needed to move compute off
the laptop; this setup is local development only, not a production deployment.

## Prerequisites

On macOS, install Docker Desktop, Node 22.12+ and the cluster tools:

```sh
brew install kind kubectl
docker desktop start
```

Allocate at least 4 CPUs and 12 GB of memory to Docker Desktop, with enough disk
space for the Python/model images and persistent volumes. First builds and model
downloads can take several minutes and require internet access.
The helper supports both `docker compose` and standalone `docker-compose` v2.

An existing Podman VM can be used instead of Docker Desktop. Start the VM if
needed and select Podman's kind provider on cluster lifecycle commands:

```sh
podman machine start
KIND_EXPERIMENTAL_PROVIDER=podman bash k8s/local.sh up
```

Use the same provider when deleting the cluster. A running Podman VM does not
need another `podman machine start`. Compose v2 is still needed to resolve the
shared configuration; application images are built with the selected runtime.
Podman images are loaded through temporary Docker-format archives, which the
helper removes after import. This avoids requiring a Docker daemon for loading.

## Start

Run from the repository root. Stop the Compose stack first if it is running,
because Kubernetes uses the same localhost ports:

```sh
bash docker/compose.sh down
bash k8s/local.sh up
```

`up` creates `payroll-local`, builds the five application image targets from the
existing Dockerfile, loads them into kind, applies all eight services to the
`payroll` namespace and waits for readiness. Repeating `up` rebuilds and restarts
the application pods. Compose is used only to resolve configuration, not to run
containers. All kubectl operations explicitly target
`kind-payroll-local`. Creating a kind cluster may change your current context;
use `kubectl config use-context <previous-context>` to restore it if needed.

| Service | Local address |
| --- | --- |
| Agent Studio | http://localhost:5173/ai_studio/ |
| TriNet demo | http://localhost:5174/trinet/ |
| Backend GraphQL/API | http://localhost:4000/ |
| TriNet payroll API | http://localhost:4100/ |
| gRPC | localhost:50051 |

kind maps NodePorts to **127.0.0.1 only**; databases, Redis and evidence capture
remain internal ClusterIP services. No ingress controller or port-forwarding
process is needed. These links assume the default `STUDIO_BASE_PATH=/ai_studio/`.

## Settings And Storage

The helper reads root `.env`, then `backend/.env`, with the same precedence and
defaults as the Docker helper. It never sources those files as shell code.
Environment values are streamed into Kubernetes Secrets without writing a
rendered manifest to disk. Do not print or commit resolved Compose configuration
or rendered manifests: they contain credentials. Local Kubernetes Secrets are
not an encrypted secret vault; anyone with cluster access can read them.

After changing settings, run:

```sh
bash k8s/local.sh apply
```

The adapter in `render.mjs` translates the shared Compose definition into
Deployments, Services, Secrets and PVCs. MySQL, pgvector, mock payroll data,
embedding caches and incident artifacts use kind's default local storage class.
All workloads have one replica and use `Recreate`, avoiding concurrent database
or SQLite writers. Compose healthchecks become startup/readiness probes; startup
allows up to ten minutes. Kubernetes does not implement Compose dependency order:
services start concurrently and failed containers restart until dependencies are
available. No aggressive liveness probe interrupts long model calls.

Kubernetes storage is **separate** from Compose volumes. Existing agents, payroll
edits and reports are not automatically migrated. Incident artifacts are in the
`incident-artifacts` PVC, not the laptop's `.local-data/incidents` directory.
Copy reports out when needed:

```sh
backend_pod=$(kubectl --context kind-payroll-local -n payroll get pods -l app=backend -o jsonpath='{.items[0].metadata.name}')
kubectl --context kind-payroll-local -n payroll cp "$backend_pod:/incident-artifacts" ./incident-artifacts
```

Back up data before deleting or recreating the cluster. Host-based model servers
such as Ollama require a host address reachable from kind; `localhost` inside a
pod refers to that pod, not your laptop.

## Operate

```sh
bash k8s/local.sh status
bash k8s/local.sh logs backend
bash k8s/local.sh down
bash k8s/local.sh up
```

`down` scales workloads to zero and preserves the cluster and PVCs. It does not
release the localhost ports reserved by the kind node. To remove the cluster,
release its ports and **permanently delete its data**, explicitly confirm:

```sh
bash k8s/local.sh delete --confirm-data-loss
```

For startup failures, inspect the affected pod and events:

```sh
kubectl --context kind-payroll-local -n payroll describe pods
kubectl --context kind-payroll-local -n payroll get events --sort-by=.lastTimestamp
```

Validate the resource adapter without running a cluster:

```sh
node --test k8s/render.test.mjs
bash -n k8s/local.sh
```