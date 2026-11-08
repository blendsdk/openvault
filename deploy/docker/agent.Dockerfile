# syntax=docker/dockerfile:1
#
# OpenVault agent image.

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/api-contract/package.json packages/api-contract/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/test-support/package.json packages/test-support/package.json
RUN pnpm install --frozen-lockfile --filter @openvault/agent...

COPY . .
RUN pnpm --filter @openvault/agent... build \
 && pnpm --filter @openvault/agent deploy --prod /out/agent

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

ENV NODE_ENV=production \
    HOME=/tmp
WORKDIR /app

# The pinned base digest can lag the Alpine package repository. Apply the
# current security fixes at build time so the runtime image is patched.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && addgroup -g 10001 openvault \
 && adduser -D -u 10001 -G openvault -h /app openvault

COPY --from=build /out/agent /app/agent
RUN printf '#!/bin/sh\nexec node /app/agent/dist/main.js "$@"\n' > /usr/local/bin/ov-agent \
 && chmod 0755 /usr/local/bin/ov-agent \
 && chown -R 10001:10001 /app

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/ov-agent"]
