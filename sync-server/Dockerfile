# Runs TypeScript directly with Bun — no build step, so a single stage is
# enough. See AGENTS.md §7.7: pre-bundling hit CJS/ESM issues with Hocuspocus
# and the cold-start delta is negligible.
#
# Build context is the repo root (not sync-server/) so we can COPY in
# shared/utils/ alongside the sync-server sources. Compose files wire
# this up via `build: { context: ., dockerfile: sync-server/Dockerfile }`.
FROM oven/bun:1.3-alpine

USER root
RUN mkdir -p /app && chown bun:bun /app
WORKDIR /app
USER bun

# Layered COPYs so source edits don't bust the install cache.
COPY --chown=bun:bun sync-server/package.json sync-server/bun.lock ./sync-server/
WORKDIR /app/sync-server
RUN bun install --frozen-lockfile

# Runtime source + shared utilities. Mirrors the repo layout so imports
# like `../../shared/utils/secrets` from `src/*.ts` resolve the same way
# inside the container as they do on a developer's machine.
COPY --chown=bun:bun sync-server/src ./src
COPY --chown=bun:bun shared /app/shared

EXPOSE 4001

# Hits the public /health route we added to the Hocuspocus onRequest hook.
# Tiny route, no S3/JWT dependencies — stays green even if upstream is flaky.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:4001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
