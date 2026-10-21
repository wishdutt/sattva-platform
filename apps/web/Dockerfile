# Web app image (Next.js standalone server). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t stagecast-web \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
#     --build-arg NEXT_PUBLIC_AUTH_MODE=oidc \
#     --build-arg NEXT_PUBLIC_OIDC_AUTHORITY=https://auth.example.com/realms/stagecast \
#     --build-arg NEXT_PUBLIC_OIDC_CLIENT_ID=stagecast-web .
# NEXT_PUBLIC_* values are inlined at build time, so build one image per environment.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w @lsp/web -w @lsp/shared -w @lsp/ui --include-workspace-root --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_AUTH_MODE=oidc
ARG NEXT_PUBLIC_COGNITO_USER_POOL_ID=
ARG NEXT_PUBLIC_COGNITO_WEB_CLIENT_ID=
ARG NEXT_PUBLIC_OIDC_AUTHORITY=
ARG NEXT_PUBLIC_OIDC_CLIENT_ID=
ARG NEXT_PUBLIC_OIDC_SCOPE="openid profile email"
ARG NEXT_PUBLIC_OIDC_PROVIDER_NAME="your organization account"
ARG NEXT_PUBLIC_LIVEKIT_WS_ORIGIN=
ARG NEXT_PUBLIC_MEDIA_ORIGIN=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_AUTH_MODE=$NEXT_PUBLIC_AUTH_MODE \
    NEXT_PUBLIC_COGNITO_USER_POOL_ID=$NEXT_PUBLIC_COGNITO_USER_POOL_ID \
    NEXT_PUBLIC_COGNITO_WEB_CLIENT_ID=$NEXT_PUBLIC_COGNITO_WEB_CLIENT_ID \
    NEXT_PUBLIC_OIDC_AUTHORITY=$NEXT_PUBLIC_OIDC_AUTHORITY \
    NEXT_PUBLIC_OIDC_CLIENT_ID=$NEXT_PUBLIC_OIDC_CLIENT_ID \
    NEXT_PUBLIC_OIDC_SCOPE=$NEXT_PUBLIC_OIDC_SCOPE \
    NEXT_PUBLIC_OIDC_PROVIDER_NAME=$NEXT_PUBLIC_OIDC_PROVIDER_NAME \
    NEXT_PUBLIC_LIVEKIT_WS_ORIGIN=$NEXT_PUBLIC_LIVEKIT_WS_ORIGIN \
    NEXT_PUBLIC_MEDIA_ORIGIN=$NEXT_PUBLIC_MEDIA_ORIGIN \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @lsp/web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
