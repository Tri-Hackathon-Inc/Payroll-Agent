FROM node:22-bookworm-slim AS graphql-deps
WORKDIR /app/graphql
COPY backend/graphql/package.json backend/graphql/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM python:3.11-slim-bookworm AS python-deps
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends default-libmysqlclient-dev build-essential pkg-config && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.lock ./
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.lock

FROM python:3.11-slim-bookworm AS backend
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=graphql-deps /usr/local/bin/node /usr/local/bin/node
COPY backend/requirements.lock ./
RUN apt-get update && apt-get install -y --no-install-recommends libmariadb3 && rm -rf /var/lib/apt/lists/*
COPY --from=python-deps /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.lock && rm -rf /wheels
COPY backend/ ./
COPY --from=graphql-deps /app/graphql/node_modules ./graphql/node_modules
EXPOSE 4000 50051
CMD ["python", "-m", "local_server.run_backend"]

FROM node:22-alpine AS ui
WORKDIR /app
COPY ui-payroll-agent/package.json ui-payroll-agent/package-lock.json ./
RUN npm ci
COPY ui-payroll-agent/ ./
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
