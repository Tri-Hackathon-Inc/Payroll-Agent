"""One-time Compose -> Kind copy. Refuses populated target databases.

Original Compose volumes and timestamped backups are retained. Run from repo root.
"""
import json
import subprocess as sp
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
KUBE = ["kubectl", "--kubeconfig", str(ROOT / ".local-data/kind-kubeconfig"), "-n", "payroll"]
COMPOSE = ["docker", "compose", "-f", str(ROOT / "infra/docker/docker-compose.yaml"), "--env-file", str(ROOT / "backend/.env")]
APPS = ["ui", "trinet-ui", "backend", "trinet-mock", "evidence-capture"]

def run(args, **kwargs):
    return sp.run(args, check=True, **kwargs)

def main():
    backup = ROOT / ".local-data" / ("kind-migration-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir()
    for name in ("db", "vector-db", "redis"):
        run(KUBE + ["rollout", "status", "deployment/" + name, "--timeout=120s"])
    mysql = ['sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE" -Nse "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()"']
    count = run(KUBE + ["exec", "deployment/db", "--"] + mysql, capture_output=True, text=True).stdout.strip()
    if count != "0":
        raise SystemExit("Target MySQL already contains tables. Refusing to overwrite it.")
    # No live application in the destination may write during restoration.
    deployments = json.loads(run(KUBE + ["get", "deployments", "-o", "json"], capture_output=True, text=True).stdout)
    if any(d['spec'].get('replicas', 0) for d in deployments['items'] if d['metadata']['name'] in APPS):
        raise SystemExit("Destination apps must be stopped before migration.")
    run(COMPOSE + ["stop"] + APPS)
    try:
        snapshots = {
            "mysql.sql": ("db", ["sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --no-tablespaces --set-gtid-purged=OFF "$MYSQL_DATABASE"']),
            "vectors.dump": ("vector-db", ["sh", "-c", 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc']),
        }
        for filename, (service, command) in snapshots.items():
            with (backup / filename).open("wb") as output:
                run(COMPOSE + ["exec", "-T", service] + command, stdout=output)
        for service, path, filename in (("trinet-mock", "/data", "trinet.tar"), ("backend", "/models", "models.tar"), ("backend", "/incident-artifacts", "incidents.tar")):
            container = run(COMPOSE + ["ps", "-aq", service], capture_output=True, text=True).stdout.strip()
            with (backup / filename).open("wb") as output:
                run(["docker", "cp", container + ":" + path + "/.", "-"], stdout=output)
        helper = {"apiVersion":"v1", "kind":"Pod", "metadata":{"name":"migration-copy", "namespace":"payroll"}, "spec":{
            "restartPolicy":"Never", "containers":[{"name":"copy", "image":"payroll-local-backend:latest", "imagePullPolicy":"Never", "command":["sleep","3600"],
            "volumeMounts":[{"name":n,"mountPath":"/restore/"+n} for n in ("trinet-data","embedding-cache","incidents")]}],
            "volumes":[{"name":n,"persistentVolumeClaim":{"claimName":n}} for n in ("trinet-data","embedding-cache","incidents")]}}
        run(KUBE + ["apply", "-f", "-"], input=json.dumps(helper).encode())
        run(KUBE + ["wait", "--for=condition=Ready", "pod/migration-copy", "--timeout=120s"])
        for filename, dest in (("trinet.tar","trinet-data"),("models.tar","embedding-cache"),("incidents.tar","incidents")):
            with (backup / filename).open("rb") as source:
                run(KUBE + ["exec", "-i", "migration-copy", "--", "tar", "xf", "-", "-C", "/restore/"+dest], stdin=source)
        with (backup / "mysql.sql").open("rb") as source:
            run(KUBE + ["exec", "-i", "deployment/db", "--", "sh", "-c", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE"'], stdin=source)
        with (backup / "vectors.dump").open("rb") as source:
            run(KUBE + ["exec", "-i", "deployment/vector-db", "--", "sh", "-c", 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error'], stdin=source)
        run(KUBE + ["delete", "pod", "migration-copy", "--wait=false"])
        run(KUBE + ["scale", "deployment"] + APPS + ["--replicas=1"])
        for name in APPS:
            run(KUBE + ["rollout", "status", "deployment/"+name, "--timeout=180s"])
        print("Migration started successfully. Backups:", backup)
        print("Validate Kind on ports 5273/5274 before stopping the original Compose databases.")
    except BaseException:
        print("Migration did not finish. Backups retained at", backup)
        print("Original Compose volumes are unchanged. Stop Kind apps before restarting Compose to avoid divergent writes.")
        raise

if __name__ == "__main__":
    main()
