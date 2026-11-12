# Playwright + Chromium baked in. We layer Bun on top so the renderer code
# matches the rest of the stack (sync-server, app). Image is large (~1.5 GB)
# but Chromium + libnss + fonts + the dozens of system libs Playwright needs
# would dominate any custom-built image anyway — using Microsoft's pinned
# image is the path of least surprise.
#
# To bump Playwright: change the version on this FROM line AND the playwright
# pin in package.json so they match. Mismatched versions wedge the launcher.
# The digest pins the exact image (a tag can be re-pushed); Dependabot moves
# tag + digest together.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy@sha256:a3966b653e8d48a30901889081b616307fca73e0d843a117fadf6609397dac38

# pipefail so a failed `curl` in the `curl | bash` below fails the build
# instead of being masked by the last stage's exit code.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Bun via the official curl install. We don't need bun for Playwright (which
# ships its Node), but the renderer's own HTTP server runs under Bun for
# stack consistency. The Bun installer requires `unzip` which the Playwright
# base image doesn't ship. The installer takes the release tag as its
# argument — pinned to the same Bun as the oven/bun images + CI
# (`bun-version`) so all three move together; without it the build
# silently picks up whatever Bun is latest that day. BUN_INSTALL puts the
# binary outside /root so the unprivileged runtime user can execute it.
#
# The base image's global npm (+ npx) is removed: nothing here uses it
# (deps install with bun), and its vendored node_modules carry fixable
# HIGH CVEs that the CI image scan would otherwise flag on every build.
# `apt` itself is upgraded: the pinned base image trails a fixed HIGH CVE
# in it that the image scan gates on.
# Firefox and WebKit are removed too: only Chromium is ever launched, and
# every browser left in the image is attack surface and image weight.
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && apt-get install -y --no-install-recommends --only-upgrade apt libapt-pkg6.0 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash -s "bun-v1.4.4" \
 && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
 && rm -rf /usr/lib/node_modules/npm /usr/bin/npm /usr/bin/npx \
 && rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-*

WORKDIR /app

# Build context is the repo root, the Bun workspace root (one lockfile;
# renderer/Dockerfile.dockerignore narrows it to the files below). Every
# workspace manifest must be present for `--frozen-lockfile` to match the
# lockfile; `--filter` installs only the renderer's dependencies plus those
# of @markoto/shared, `--production` skips devDependencies. Install layer
# first so source edits don't bust the package cache. Everything under
# /app stays root-owned: the runtime user can read it but not change it.
COPY package.json bun.lock bunfig.toml ./
COPY shared/package.json shared/
COPY sync-server/package.json sync-server/
COPY renderer/package.json renderer/
RUN bun install --frozen-lockfile --ignore-scripts --production --filter markoto-renderer

# `shared/` sits next to the renderer as in the repository, so
# `renderer/src` can import shared modules by the same relative paths
# the app and the sync server use.
COPY shared ./shared
COPY renderer/src ./renderer/src
WORKDIR /app/renderer

# Run unprivileged as the base image's `pwuser` (uid 1000). Chromium keeps
# its own sandbox (no --no-sandbox, see src/render.ts): as a non-root user
# it uses unprivileged user namespaces, which compose allows through the
# seccomp profile in deploy/config/renderer/seccomp.json. HOME points at /tmp because the
# compose files mount the root filesystem read-only with a tmpfs on /tmp
# (Chromium writes its profile, crashpad and font caches under HOME).
ENV HOME=/tmp
USER pwuser

EXPOSE 9000

# Tiny, no-deps healthcheck — wget ships in the Playwright base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:9000/health || exit 1

CMD ["bun", "run", "src/index.ts"]
