# Runs TypeScript directly with Bun — no build step, so a single stage is
# enough. See AGENTS.md §7.7: pre-bundling hit CJS/ESM issues with Hocuspocus
# and the cold-start delta is negligible.
#
# Build context is the repo root (not sync-server/) so we can COPY in
# shared/utils/ alongside the sync-server sources. Compose files wire
# this up via `build: { context: ., dockerfile: sync-server/Dockerfile }`.
FROM oven/bun:1.3-alpine@sha256:26d8996560ca94eab9ce48afc0c7443825553c9a851f40ae574d47d20906826d

USER root
RUN mkdir -p /app && chown bun:bun /app
WORKDIR /app
USER bun

# Layered COPYs so source edits don't bust the install cache.
COPY --chown=bun:bun sync-server/package.json sync-server/bun.lock ./sync-server/
WORKDIR /app/sync-server
RUN bun install --frozen-lockfile

# `shared/` is its own self-contained package — package.json declares its
# direct npm deps (`jsonwebtoken`) so Bun's standard module resolution
# from `shared/utils/secrets.ts` finds them in `shared/node_modules/`.
# Without this, `bun run src/index.ts` fails at startup with
# `Cannot find package 'jsonwebtoken' from /app/shared/utils/secrets.ts`
# because the resolver walks up only ANCESTORS of the importing file,
# and `/app/sync-server/node_modules/` is a sibling, not an ancestor.
# Installed as a separate layer so a sync-server source edit doesn't
# bust the shared/ install cache.
WORKDIR /app
COPY --chown=bun:bun shared/package.json shared/bun.lock ./shared/
WORKDIR /app/shared
RUN bun install --frozen-lockfile

# Runtime source + the rest of shared/. The package.json + bun.lock are
# already there from the install layer; the rest is the source the sync
# server imports at runtime.
COPY --chown=bun:bun sync-server/src /app/sync-server/src
COPY --chown=bun:bun shared /app/shared

WORKDIR /app/sync-server

EXPOSE 4001

# Hits the public /health route we added to the Hocuspocus onRequest hook.
# Tiny route, no S3/JWT dependencies — stays green even if upstream is flaky.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:4001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
