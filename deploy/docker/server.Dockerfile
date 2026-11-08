# syntax=docker/dockerfile:1
#
# OpenVault server and CLI image.
#
# The image contains the server, the `ov` CLI, and the built SPA. Compose runs
# the API and the static web container separately; a single-container
# deployment can still serve the SPA from this image.

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
RUN pnpm install --frozen-lockfile

COPY . .
# The ellipsis builds workspace dependencies (core and api-contract) first.
RUN pnpm --filter @openvault/server... build \
 && pnpm --filter @openvault/cli... build \
 && pnpm --filter @openvault/web... build
RUN pnpm --filter @openvault/server deploy --prod /out/server \
 && pnpm --filter @openvault/cli deploy --prod /out/cli

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

ENV NODE_ENV=production \
    HOME=/tmp
WORKDIR /app

RUN addgroup -g 10001 openvault \
 && adduser -D -u 10001 -G openvault -h /app openvault

COPY --from=build /out/server /app/server
COPY --from=build /out/cli /app/cli
COPY --from=build /src/apps/web/dist /app/web/dist

RUN printf '#!/bin/sh\nexec node /app/cli/dist/main.js "$@"\n' > /usr/local/bin/ov \
 && chmod 0755 /usr/local/bin/ov \
 && chown -R 10001:10001 /app

USER 10001:10001
EXPOSE 8443 8444
ENTRYPOINT ["node", "/app/server/dist/main.js"]
