#!/usr/bin/env bash
set -euo pipefail
if pgrep -f '^/usr/local/bin/k3s server' >/dev/null; then
  echo 'K3s is already running.'
  exit 0
fi
test -x /usr/local/bin/k3s
test -f /etc/rancher/k3s/config.yaml
umask 077
nohup /usr/local/bin/k3s server > /var/log/payroll-k3s.log 2>&1 < /dev/null &
echo "Started K3s process $!. Logs: /var/log/payroll-k3s.log"
