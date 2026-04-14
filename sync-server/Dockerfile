# Runs TypeScript directly with Bun — no build step, so a single stage is
# enough. See AGENTS.md §7.7: pre-bundling hit CJS/ESM issues with Hocuspocus
# and the cold-start delta is negligible.
FROM oven/bun:1.3-alpine

WORKDIR /app
# /app is created by WORKDIR as root-owned. Hand it to bun so the unprivileged
# install can write node_modules.
RUN chown bun:bun /app

# Dependency layer first so source edits don't bust the install cache.
COPY --chown=bun:bun package.json bun.lock ./
USER bun
RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .

EXPOSE 4001

# Hits the public /health route we added to the Hocuspocus onRequest hook.
# Tiny route, no S3/JWT dependencies — stays green even if upstream is flaky.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:4001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
