#!/bin/sh
set -e

python manage.py migrate --noinput

if [ "${SEED_SAMPLE_AGENTS:-false}" = "true" ]; then
  python manage.py seed_agents
fi

exec python manage.py runserver 0.0.0.0:8000
