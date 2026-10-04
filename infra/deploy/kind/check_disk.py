"""Fail before large image/model downloads when the workspace drive is nearly full."""
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[3]
free = shutil.disk_usage(root).free / (1024**3)
minimum = 35
print(f"Workspace drive free space: {free:.1f} GiB")
if free < minimum:
    raise SystemExit(f"Model setup stopped: free at least {minimum} GiB before downloading/loading Ray, vLLM and weights.")
print("Disk preflight passed. Also check the Docker disk location if it is on another drive.")
