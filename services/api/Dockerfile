# Standalone API image (non-AWS deployment). Build from the repository root:
#   docker build -f services/api/Dockerfile -t stagecast-api .
# The esbuild bundle is self-contained, so the runtime image has no node_modules.

FROM node:22-alpine AS build
WORKDIR /repo
# Workspace manifests first for better layer caching (npm ci needs every workspace's package.json).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w @lsp/api -w @lsp/shared --include-workspace-root --ignore-scripts --no-audit --no-fund \
  && npm rebuild esbuild
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/api services/api
RUN npm run build -w @lsp/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /repo/services/api/dist/server ./server
COPY --from=build --chown=node:node /repo/services/api/dist/migrate ./migrate
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
# Migrations also run on start unless MIGRATE_ON_START=false (then run: node migrate/index.mjs).
CMD ["node", "--enable-source-maps", "server/index.mjs"]
