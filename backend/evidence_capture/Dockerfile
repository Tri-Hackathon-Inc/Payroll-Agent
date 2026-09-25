# Headless browser for read-only incident evidence screenshots (see server.js).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npx playwright install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY server.js ./
EXPOSE 4300
CMD ["node", "server.js"]
