# Temporary mock of the TriNet payroll GraphQL API; build with backend/trinet_mock as the context.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY *.js schema.graphql schema.sql ./
COPY seed ./seed

EXPOSE 4100
ENV HOST=0.0.0.0 PORT=4100
# node:sqlite is built in but still marked experimental; silence its startup warning.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
