# Run the platform

## 1. Start Docker

Start Docker Desktop. Run container commands from the repository root.

```sh
docker desktop start
```

## 2. Start the application

**Choose the command for your terminal.** Run it from the repository root.

### PowerShell

Start the stack from PowerShell without Bash. Requires `backend/.env`; add `--env-file .env` before it if using root settings.

```powershell
docker compose -f docker/docker-compose.yaml --env-file backend/.env up --build -d --wait
```

### Bash

Build and start the full Docker stack. Loads `.env` and `backend/.env` when present; applies backend migrations automatically. Requires Bash.

```sh
bash docker/compose.sh up --build -d --wait
```

## 3. Open the application

Run these commands in PowerShell, or open the URLs in your browser.

Open Agent Studio from PowerShell. Manage agent groups and service permissions under Access control.

```powershell
Start-Process http://localhost:5173/ai_studio/
```

Open the payroll demo from PowerShell.

```powershell
Start-Process http://localhost:5174/trinet/
```

Open the backend GraphQL Sandbox from PowerShell.

```powershell
Start-Process http://localhost:4000/
```

## 4. Apply changes

The commands below use Bash and load the existing environment files.

Rebuild application containers after source changes; keep databases and Redis running.

```sh
bash docker/compose.sh up --build --no-deps -d --wait backend ui trinet-mock trinet-ui evidence-capture
```

Reload backend environment settings after changing credentials or model routing.

```sh
bash docker/compose.sh up --force-recreate --no-deps -d --wait backend
```

## 5. Check a problem

| Description | Command |
| --- | --- |
| Show container status. | `bash docker/compose.sh ps --all` |
| Show recent backend logs. | `bash docker/compose.sh logs --tail=100 backend` |
| Show recent logs for all services. | `bash docker/compose.sh logs --tail=100` |
| Validate Compose settings without printing resolved credentials. | `bash docker/compose.sh config --quiet` |

## 6. Stop the application

Remove containers and the network while preserving database volumes.

```sh
bash docker/compose.sh down
```

<details>
<summary>Use Podman instead of Docker</summary>

Create a Podman VM on macOS once, if none exists. Use Docker or Podman, one at a time.

```sh
podman machine init --cpus 4 --memory 8192 --disk-size 50
```

Start the Podman VM.

```sh
podman machine start
```

Build and start the stack using Podman and `podman-compose`; loads both environment files when present.

```sh
bash docker/podman.sh up --build -d
```

| Description | Command |
| --- | --- |
| Show Podman container status. | `bash docker/podman.sh ps` |
| Show recent Podman service logs. | `bash docker/podman.sh logs --tail=100` |
| Validate Podman Compose settings. | `bash docker/podman.sh config --quiet` |
| Rebuild and reload application containers with Podman. | `bash docker/podman.sh up --build --force-recreate --no-deps -d backend ui trinet-mock trinet-ui evidence-capture` |
| Remove Podman containers while preserving database volumes. | `bash docker/podman.sh down` |

</details>

<details>
<summary>Develop Agent Studio locally</summary>

Run from the repository root. Stop the container UI first to free port 5173; keep the backend running.

```sh
bash docker/compose.sh stop ui
```

| Description | Command |
| --- | --- |
| Install Agent Studio dependencies. Local development requires Node 22.12+ or Node 24. | `npm --prefix ui-payroll-agent ci` |
| Start Agent Studio locally on port 5173; proxies APIs to the backend on port 4000 by default. | `npm --prefix ui-payroll-agent run dev` |
| Build Agent Studio and its embedded chat template into `ui-payroll-agent/dist/browser/`. | `npm --prefix ui-payroll-agent run build` |

</details>

<details>
<summary>Run tests</summary>

| Description | Command |
| --- | --- |
| Check strict TypeScript and Angular templates. | `npm --prefix ui-payroll-agent run lint` |
| Run frontend unit and GraphQL contract tests. | `npm --prefix ui-payroll-agent test` |
| Run backend Python tests against an isolated SQLite test database using the built image. | `bash docker/compose.sh run --rm --no-deps -e MYSQL_HOST= -e DATABASE_PATH=:memory: -e HF_TOKEN= backend python manage.py test tests --noinput` |
| Run backend JavaScript transport tests using the built image. | `bash docker/compose.sh run --rm --no-deps backend npm test` |

Run browser commands from `ui-payroll-agent/`.

| Description | Command |
| --- | --- |
| Install the browser for UI tests; run from `ui-payroll-agent/` after installing dependencies. | `npx playwright install chromium` |
| Test the embedded chat and payroll host using local fixtures. Run from `ui-payroll-agent/` after building Studio and installing both UIs' dependencies. | `npx playwright test --config playwright.runtime.config.js` |
| Test access-control creation, editing, mapping, and revocation against the running stack. Set `STUDIO_TEST_URL=http://localhost:5173/ai_studio/` and use admin access; temporary groups are removed afterward. | `npx playwright test --config playwright.access.config.js` |

</details>

<details>
<summary>Manage backend data and templates</summary>

| Description | Command |
| --- | --- |
| Check applied backend migrations, including agent access-control tables. | `bash docker/compose.sh exec backend python manage.py showmigrations registry` |
| Validate the agent template catalog. | `bash docker/compose.sh exec backend python manage.py validate_templates` |
| Synchronize the database catalog with template files in the running image. Rebuild first after editing local files. | `bash docker/compose.sh exec backend python manage.py sync_templates` |
| Provision a Leaves domain; matching templates, services, and agent permissions must be configured separately. | `bash docker/compose.sh exec backend python manage.py create_domain leaves --label Leaves --domain Leaves` |
| Validate payroll history ingestion for the records profile without writing data. Remove `--dry-run` to import. | `bash docker/compose.sh exec backend python manage.py ingest_anomaly_payroll_history --domain payroll-services --dry-run` |

</details>
