"""Copy service environment into namespace-scoped Secrets; never print values."""
import json
import subprocess
import secrets
from pathlib import Path

root = Path(__file__).resolve().parents[3]
result = subprocess.run(["docker", "compose", "-f", "infra/docker/docker-compose.yaml", "--env-file", "backend/.env",
                         "config", "--format", "json"], cwd=root, check=True, capture_output=True, text=True)
config = json.loads(result.stdout)
items = []
key_path = root / ".local-data" / "vllm-api-key"
key_path.parent.mkdir(exist_ok=True)
if not key_path.exists():
    key_path.write_text(secrets.token_urlsafe(48), encoding="utf-8")
model_key = key_path.read_text(encoding="utf-8").strip()
for name in ("db", "vector-db", "backend", "trinet-mock"):
    values = {k:str(v) for k,v in config["services"][name].get("environment", {}).items() if v is not None}
    if name == "backend":
        values["VLLM_API_KEY"] = model_key
    items.append({"apiVersion":"v1","kind":"Secret","metadata":{"name":name+"-env","namespace":"payroll"},
                  "type":"Opaque","stringData":values})
destination = root / ".local-data" / "kind-secrets.json"
destination.write_text(json.dumps({"apiVersion":"v1","kind":"List","items":items}),encoding="utf-8")
print("Prepared service secrets in ignored .local-data/kind-secrets.json; values not printed.")
model_secret = {"apiVersion":"v1","kind":"Secret","metadata":{"name":"vllm-auth","namespace":"agent-models"},
                "type":"Opaque","stringData":{"api-key":model_key}}
(root / ".local-data/kind-model-secret.json").write_text(json.dumps(model_secret),encoding="utf-8")
