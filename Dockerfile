# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ packages/
# Optional CA is for managed build proxies. Ordinary Coolify builds need no secret.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --no-audit --no-fund; \
    else npm ci --no-audit --no-fund; fi
COPY . .
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api ./apps/api
COPY --from=build --chown=node:node /app/apps/worker ./apps/worker
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/infra/schema.sql ./infra/schema.sql
COPY --from=build --chown=node:node /app/infra/migrations ./infra/migrations
COPY --from=build --chown=node:node /app/scripts/migrations.ts /app/scripts/roles.ts /app/scripts/deploy-migrate.ts /app/scripts/container-health.ts /app/scripts/testnet-preflight.ts /app/scripts/container-entrypoint.ts /app/scripts/installation-secrets.ts ./scripts/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=8s --start-period=30s --retries=5 CMD ["node", "--import", "tsx", "scripts/container-health.ts"]
CMD ["node", "--use-env-proxy", "--import", "tsx", "apps/api/src/server.ts"]
