# Playwright + Chromium baked in. We layer Bun on top so the renderer code
# matches the rest of the stack (sync-server, app). Image is large (~1.5 GB)
# but Chromium + libnss + fonts + the dozens of system libs Playwright needs
# would dominate any custom-built image anyway — using Microsoft's pinned
# image is the path of least surprise.
#
# To bump Playwright: change the version on this FROM line AND the playwright
# pin in package.json so they match. Mismatched versions wedge the launcher.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# Bun via the official curl install. We don't need bun for Playwright (which
# ships its Node), but the renderer's own HTTP server runs under Bun for
# stack consistency. The Bun installer requires `unzip` which the Playwright
# base image doesn't ship.
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash \
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /app

# Layered COPYs so source edits don't bust the install cache.
COPY package.json ./
RUN bun install --no-save

COPY src ./src

EXPOSE 9000

# Tiny, no-deps healthcheck — wget ships in the Playwright base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:9000/health || exit 1

CMD ["bun", "run", "src/index.ts"]
