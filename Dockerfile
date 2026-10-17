# syntax=docker/dockerfile:1.7
# =============================================================================
# PayHub — one Dockerfile, one build, four runtime images.
#
# The services share a compiled tree, so building them separately would mean
# compiling the same libs four times. Instead there is a single `build` stage
# and four thin runtime targets that differ only in their CMD.
# =============================================================================

# -----------------------------------------------------------------------------
# 1. deps — production dependencies only, cached on the lockfile alone
# -----------------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app

# Copying only the manifests first means a source-code change does not
# invalidate the (slow) dependency layer.
COPY package.json package-lock.json ./
# Two installs, one layer: the pruned tree is stashed for the runtime
# stage, then the full tree (including devDependencies) is restored so the
# build stage can compile and typecheck.
#
# `--omit=optional` is deliberately NOT used: @node-rs/argon2 ships its
# platform binary as an optional dependency, and dropping it turns every
# login into a runtime crash.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts && \
    cp -R node_modules /prod_node_modules && \
    npm ci --ignore-scripts

# -----------------------------------------------------------------------------
# 2. build — typecheck, compile, rewrite path aliases
# -----------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json ./
COPY libs ./libs
COPY apps ./apps

# `npm run build` = tsc + tsc-alias. A type error fails the image build,
# which is the point: a broken build must never produce a deployable image.
RUN npm run build

# -----------------------------------------------------------------------------
# 3. runtime-base — the shared runtime layer
# -----------------------------------------------------------------------------
FROM node:24-alpine AS runtime-base
WORKDIR /app

# dumb-init becomes PID 1 and forwards signals to node. Without it a
# `CMD npm start` leaves npm as PID 1, SIGTERM is swallowed, and Docker
# SIGKILLs the container after the grace period — losing every in-flight
# request. `CMD ["node", ...]` avoids the shell, and dumb-init additionally
# reaps zombies.
RUN apk add --no-cache dumb-init tini curl

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=512"

COPY --from=deps  /prod_node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# .proto files are not compiled; `npm run build` copies them into dist/ so
# the same relative path works in development and in the image.

# Never run as root. `node` (uid 1000) ships with the base image.
USER node

ENTRYPOINT ["dumb-init", "--"]

# -----------------------------------------------------------------------------
# 4. the four services
# -----------------------------------------------------------------------------
FROM runtime-base AS api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/health/ready || exit 1
CMD ["node", "dist/apps/api/src/main.js"]

FROM runtime-base AS ledger
EXPOSE 3001 50051
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3001}/health/ready || exit 1
CMD ["node", "dist/apps/ledger/src/main.js"]

FROM runtime-base AS worker
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3002}/health/live || exit 1
CMD ["node", "dist/apps/worker/src/main.js"]

FROM runtime-base AS notifications
EXPOSE 3003
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3003}/health/live || exit 1
CMD ["node", "dist/apps/notifications/src/main.js"]
