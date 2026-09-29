# Run the containers

Run from the repository root. Use Docker or Podman, one at a time.
Install Docker Desktop with Compose v2, or Podman with `podman-compose`.

## 1. Starter

**Docker:** start Docker Desktop.

```sh
docker desktop start
```

**Podman on macOS:** create a VM once. Skip if one already exists.

```sh
podman machine init --cpus 4 --memory 8192 --disk-size 50
```

Start the VM if it is stopped.

```sh
podman machine start
```

## 2. Load

Start the UI, backend, databases and supporting services.
Keep credentials in `backend/.env`, or create an empty file for defaults.

**Docker:** build and start all services.

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env up --build -d --wait
```

**Podman:** build and start all services. Loads both `.env` files automatically.

```sh
bash docker/podman.sh up --build -d
```

For Docker settings in both files, use `--env-file .env --env-file backend/.env`.

### Reload after adding or changing files

Source files are copied into images, so adding or changing them requires a rebuild.
With the stack running, use one command below to rebuild and replace the app
containers. Databases and Redis stay running.

**Docker: rebuild and reload apps.**

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env up --build --force-recreate --no-deps -d --wait backend ui trinet-mock trinet-ui evidence-capture
```

**Podman: rebuild and reload apps.**

```sh
bash docker/podman.sh up --build --force-recreate --no-deps -d backend ui trinet-mock trinet-ui evidence-capture
```

### Stop and remove containers

Stop and remove this project's containers and network. Keep database volumes and images.

**Docker:**

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env down
```

**Podman:**

```sh
bash docker/podman.sh down
```

## 3. Troubleshooting

**Docker:** check the engine, settings, container status and logs.

```sh
docker info
docker compose -f docker/docker-compose.yaml --env-file backend/.env config --quiet
docker compose -f docker/docker-compose.yaml --env-file backend/.env ps --all
docker compose -f docker/docker-compose.yaml --env-file backend/.env logs --tail=100
```

**Podman:** check the VM, engine, settings, container status and logs.

```sh
podman machine list
podman info
bash docker/podman.sh config --quiet
bash docker/podman.sh ps
bash docker/podman.sh logs --tail=100
```

If the engine is stopped, repeat Starter. For service errors, check logs.
If a port is busy, stop the other stack.
