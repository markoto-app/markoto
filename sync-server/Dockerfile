# Runs TypeScript directly with Bun — no build step, so a single stage is
# enough. See AGENTS.md §7.7: pre-bundling hit CJS/ESM issues with Hocuspocus
# and the cold-start delta is negligible.
#
# Build context is the repo root (not sync-server/) so we can COPY in
# shared/utils/ alongside the sync-server sources. Compose files wire
# this up via `build: { context: ., dockerfile: sync-server/Dockerfile }`.
# Pinned digest corresponds to oven/bun:1.4.4-alpine at the time of bump.
FROM oven/bun@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a

USER root
RUN mkdir -p /app && chown bun:bun /app
WORKDIR /app
USER bun

# Layered COPYs so source edits don't bust the install cache.
# `--chown=root:root --chmod=755` makes the source FILES immutable to the
# runtime `bun` user (defense in depth — see docker:S6504); `bun install
# --ignore-scripts` blocks postinstall script execution from compromised
# packages even when they're on bun's built-in trustedDependencies list
# (docker:S6505).
#
# CRITICAL ORDERING: `WORKDIR` runs BEFORE the `COPY` so the target
# directory is created by `WORKDIR` (inheriting the current USER, `bun`)
# and the COPY only writes FILES into it. The naive order (COPY first,
# WORKDIR second) makes COPY create the parent directory with its own
# `--chown=root:root --chmod=755`, which is what Sonar S6504 wants for
# files but blocks `bun install` from creating `node_modules` (parent
# dir not bun-writable → EACCES). Same issue applied to `shared/` below.
WORKDIR /app/sync-server
COPY --chown=root:root --chmod=755 sync-server/package.json sync-server/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# `shared/` is its own self-contained package — package.json declares its
# direct npm deps (`jsonwebtoken`) so Bun's standard module resolution
# from `shared/utils/secrets.ts` finds them in `shared/node_modules/`.
# Without this, `bun run src/index.ts` fails at startup with
# `Cannot find package 'jsonwebtoken' from /app/shared/utils/secrets.ts`
# because the resolver walks up only ANCESTORS of the importing file,
# and `/app/sync-server/node_modules/` is a sibling, not an ancestor.
# Installed as a separate layer so a sync-server source edit doesn't
# bust the shared/ install cache.
WORKDIR /app/shared
COPY --chown=root:root --chmod=755 shared/package.json shared/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Runtime source + the rest of shared/. The package.json + bun.lock are
# already there from the install layer; the rest is the source the sync
# server imports at runtime. Both target dirs already exist from the
# WORKDIRs above, so these COPYs just drop files in (no parent-dir
# perm churn).
COPY --chown=root:root --chmod=755 sync-server/src /app/sync-server/src
COPY --chown=root:root --chmod=755 shared /app/shared

WORKDIR /app/sync-server

EXPOSE 4001

# Hits the public /health route we added to the Hocuspocus onRequest hook.
# Tiny route, no S3/JWT dependencies — stays green even if upstream is flaky.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:4001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
