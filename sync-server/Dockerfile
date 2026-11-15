# Runs TypeScript directly with Bun: no build step, so a single stage is
# enough: pre-bundling hit CJS/ESM issues with Hocuspocus
# and the cold-start delta is negligible.
#
# Build context is the repo root, the Bun workspace root: the sync server
# imports `shared/` (the @markoto/shared workspace package) as TypeScript
# source, and the one lockfile lives there. sync-server/Dockerfile.dockerignore
# narrows the context to the files below. Compose:
# `build: { context: <repo root>, dockerfile: sync-server/Dockerfile }`.
# Pinned digest corresponds to oven/bun:1.4.4-alpine at the time of bump.
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a

USER root
RUN mkdir -p /app && chown bun:bun /app
WORKDIR /app
USER bun

# Install layer first, so source edits don't bust the package cache. Every
# workspace manifest must be present for `--frozen-lockfile` to match the
# lockfile; `--filter` then installs only the sync server's dependencies
# (and those of the workspace packages it depends on, i.e. @markoto/shared),
# `--production` skips devDependencies. Hoisted into /app/node_modules,
# which `sync-server/src` and `shared/` both reach by walking up.
#
# `--chown=root:root --chmod=755` keeps the source FILES immutable to the
# runtime `bun` user (docker:S6504); /app itself stays bun-owned so the
# install can create node_modules. `--ignore-scripts` blocks install
# scripts of compromised packages, even trusted-by-default ones
# (docker:S6505).
COPY --chown=root:root --chmod=755 package.json bun.lock bunfig.toml ./
COPY --chown=root:root --chmod=755 shared/package.json shared/
COPY --chown=root:root --chmod=755 sync-server/package.json sync-server/
COPY --chown=root:root --chmod=755 renderer/package.json renderer/
RUN bun install --frozen-lockfile --ignore-scripts --production --filter markoto-sync-server

COPY --chown=root:root --chmod=755 shared /app/shared
COPY --chown=root:root --chmod=755 sync-server/src /app/sync-server/src

WORKDIR /app/sync-server

EXPOSE 4001

# Hits the public /health route we added to the Hocuspocus onRequest hook.
# Tiny route, no S3/JWT dependencies: stays green even if upstream is flaky.
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:4001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
