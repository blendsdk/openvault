# syntax=docker/dockerfile:1
#
# OpenVault static web UI image.

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
RUN pnpm install --frozen-lockfile --filter @openvault/web...

COPY . .
RUN pnpm --filter @openvault/web... build

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS runtime

# The pinned base digest can lag the Alpine package repository. Apply the
# current security fixes at build time so the runtime image is patched.
USER root
RUN apk upgrade --no-cache

COPY deploy/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
