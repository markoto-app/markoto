# --- Builder stage ---------------------------------------------------------
# We run the build as the built-in `bun` user (uid 1000) so the resulting
# node_modules/.output trees aren't owned by root when copied across stages.
FROM oven/bun:1.3-alpine AS builder
# WORKDIR creates /app owned by root by default — must chown before USER switch
# or bun install can't write node_modules.
USER root
RUN mkdir -p /app && chown bun:bun /app
WORKDIR /app
USER bun

# Dependency install layer first, so source changes don't bust the package cache.
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .
RUN bun run build

# Nitro's node-file-trace misses `ws` — it's imported deep inside
# `@google/genai/dist/node/index.mjs` via a package.json re-export that the
# tracer doesn't follow. `index.mjs` still emits `import 'ws'` at runtime, so
# we copy the package into the output's node_modules so Node can resolve it.
RUN cp -r node_modules/ws .output/server/node_modules/ws

# --- Runtime stage ---------------------------------------------------------
# Nitro outputs plain .mjs — runtime doesn't need Bun. We ship Node here
# because lib0@0.2.117 has a broken `bun` conditional export
# (`./logging` → `./logging.js` which isn't in the published tarball; only
# `./logging.node.js` exists, which Node picks via the `node` condition).
# Builder stays on Bun for fast installs + TS handling.
FROM node:24-alpine

WORKDIR /app
COPY --from=builder --chown=node:node /app/.output .output
# Drizzle migration files — applied at boot by server/plugins/db-migrate.ts.
# Path resolution uses process.cwd() (= /app), so the plugin reads ./drizzle.
COPY --from=builder --chown=node:node /app/drizzle ./drizzle

USER node
EXPOSE 3000

# Health probe hits the DB-touching /api/health so a wedged DB connection
# surfaces as unhealthy, not just a live HTTP port.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=5 http://127.0.0.1:3000/api/health || exit 1

CMD ["node", ".output/server/index.mjs"]
