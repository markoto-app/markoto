# --- Builder stage ---------------------------------------------------------
# We run the build as the built-in `bun` user (uid 1000) so the resulting
# node_modules/.output trees aren't owned by root when copied across stages.
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS builder
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
# Operator CLIs. The runtime stage ships only the Nitro output — no
# scripts/ dir, no node_modules — so standalone scripts are bundled into
# single files (deps inlined) that run with the image's bun:
#   docker compose exec app bun cli/reembed-knowledge.js [--dry-run]
RUN bun build scripts/reembed-knowledge.ts --target=bun --outfile=cli/reembed-knowledge.js

# --- Runtime stage ---------------------------------------------------------
# Nitro's `bun` preset emits an output targeted at the Bun runtime — it
# traces via Bun's conditional exports, so packages like lib0 resolve to
# their `bun` export variants consistently. Running this output under
# Node would fail (module graph references Bun-only paths).
#
# Production command per https://bun.com/docs/guides/ecosystem/nuxt:
# `bun run ./.output/server/index.mjs`.
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a

USER root
RUN mkdir -p /app && chown bun:bun /app
WORKDIR /app
COPY --from=builder --chown=bun:bun /app/.output .output
# Drizzle migration files — applied at boot by server/plugins/db-migrate.ts.
# Path resolution uses process.cwd() (= /app), so the plugin reads ./drizzle.
COPY --from=builder --chown=bun:bun /app/drizzle ./drizzle
# Runtime-read source files that are NOT part of the Nitro .output bundle
# (fs reads aren't traced by Nitro's NFT, so they must be COPYed explicitly
# — same rationale as drizzle/). Both are read via process.cwd():
#   - content/legal/*.md    → server/api/_internal/legal/[slug].get.ts
#   - shared/templates/...  → server/utils/documents/templateRenderer.ts
# Missing them 500s every /legal/* page and drops every template body.
COPY --from=builder --chown=bun:bun /app/content ./content
COPY --from=builder --chown=bun:bun /app/shared/templates/content ./shared/templates/content
# Bundled operator CLIs (see the builder stage).
COPY --from=builder --chown=bun:bun /app/cli ./cli

USER bun
EXPOSE 3000

# Health probe hits the DB-touching /api/health so a wedged DB connection
# surfaces as unhealthy, not just a live HTTP port.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=5 http://127.0.0.1:3000/api/health || exit 1

CMD ["bun", "run", ".output/server/index.mjs"]
