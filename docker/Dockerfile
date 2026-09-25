FROM docker.io/library/node:22-bookworm-slim AS graphql-deps
WORKDIR /app/graphql
COPY backend/graphql/package.json backend/graphql/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM docker.io/library/python:3.11-slim-bookworm AS python-deps
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends default-libmysqlclient-dev build-essential pkg-config && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.lock ./
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.lock

FROM docker.io/library/python:3.11-slim-bookworm AS backend
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

FROM docker.io/library/node:22-alpine AS ui
WORKDIR /app
COPY ui-payroll-agent/package.json ui-payroll-agent/package-lock.json ./
RUN npm ci
COPY ui-payroll-agent/ ./
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Read-only screenshots for incident reports. Shares the repository-root build context.
FROM docker.io/library/node:22-bookworm-slim AS evidence-capture
WORKDIR /app
COPY backend/evidence_capture/package.json backend/evidence_capture/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npx playwright install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY backend/evidence_capture/server.js ./
EXPOSE 4300
CMD ["node", "server.js"]

# Optional TriNet payroll API and UI. All targets use the repository root context.
FROM docker.io/library/node:22-bookworm-slim AS trinet-mock
WORKDIR /app
COPY backend/trinet_mock/package.json backend/trinet_mock/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY backend/trinet_mock/*.js backend/trinet_mock/schema.graphql backend/trinet_mock/schema.sql ./
COPY backend/trinet_mock/seed ./seed
EXPOSE 4100
ENV HOST=0.0.0.0 PORT=4100
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

FROM docker.io/library/node:22-alpine AS trinet-ui
WORKDIR /app
COPY ui-trinet-mock/package.json ui-trinet-mock/package-lock.json ./
RUN npm ci
COPY ui-trinet-mock/ ./
EXPOSE 5174
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
