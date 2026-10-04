#!/usr/bin/env bash
set -euo pipefail
# Run as root in the Ubuntu WSL distribution. Does not restart Docker Desktop.
version="${K3S_VERSION:-v1.34.11+k3s1}"
if [ -e /usr/local/bin/k3s ]; then
  /usr/local/bin/k3s --version
  echo 'K3s already installed; refusing to replace the binary.'
  exit 0
fi
install -d -m 700 /var/lib/payroll-k3s-install
cd /var/lib/payroll-k3s-install
curl --fail --location --retry 3 --output k3s "https://github.com/k3s-io/k3s/releases/download/${version}/k3s"
curl --fail --location --retry 3 --output sha256sum-amd64.txt "https://github.com/k3s-io/k3s/releases/download/${version}/sha256sum-amd64.txt"
grep -E '  k3s$' sha256sum-amd64.txt | sha256sum --check
install -m 755 k3s /usr/local/bin/k3s
install -d -m 700 /etc/rancher/k3s
if [ ! -e /etc/rancher/k3s/config.yaml ]; then
  cat > /etc/rancher/k3s/config.yaml <<'CONFIG'
node-name: payroll-local
write-kubeconfig-mode: "0600"
disable:
  - traefik
  - servicelb
prefer-bundled-bin: true
tls-san:
  - localhost
  - 127.0.0.1
CONFIG
fi
echo 'K3s installed. Run start-wsl.sh to start it.'
