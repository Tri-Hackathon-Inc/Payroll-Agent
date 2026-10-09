"""Verify the local endpoint with synthetic text only. No payroll data is read."""
import json
import os
from urllib.request import Request, urlopen

def main():
    base = os.getenv("VLLM_BASE_URL", "http://127.0.0.1:8000/v1").rstrip("/")
    key = os.getenv("VLLM_API_KEY")
    if not key:
        raise SystemExit("Set VLLM_API_KEY to the model server's key.")
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    with urlopen(Request(base + "/models", headers=headers), timeout=15) as response:
        models = json.load(response)
    if not any(item.get("id") == "agent-slm" for item in models.get("data", [])):
        raise SystemExit("The endpoint is not serving agent-slm.")
    payload = {"model": "agent-slm", "messages": [{"role": "user", "content": "Reply with the word READY."}],
               "max_tokens": 16, "temperature": 0, "stream": False}
    with urlopen(Request(base + "/chat/completions", headers=headers, data=json.dumps(payload).encode()), timeout=90) as response:
        result = json.load(response)
    if not result.get("choices", [{}])[0].get("message", {}).get("content", "").strip():
        raise SystemExit("The model did not return text.")
    print("PASS: agent-slm is served and generated a synthetic response.")

if __name__ == "__main__":
    main()
