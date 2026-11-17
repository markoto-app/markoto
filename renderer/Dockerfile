# Playwright + Chromium baked in. We layer Bun on top so the renderer code
# matches the rest of the stack (sync-server, app). Image is large (~1.5 GB)
# but Chromium + libnss + fonts + the dozens of system libs Playwright needs
# would dominate any custom-built image anyway: using Microsoft's pinned
# image is the path of least surprise.
#
# To bump Playwright: change the version on this FROM line AND the playwright
# pin in package.json so they match. Mismatched versions wedge the launcher.
# The digest pins the exact image (a tag can be re-pushed); Dependabot moves
# tag + digest together. Dependabot does NOT bump the npm side (ignored in
# .github/dependabot.yml): its image PR must also set `playwright` and
# `@playwright/test` in package.json and renderer/package.json (+ bun.lock).
FROM mcr.microsoft.com/playwright:v1.65.1-jammy@sha256:b0ee5ce5e14ac42c394c0564a0a30adbda052153c611561bb2d31263593d6dd8

# pipefail so a failed `curl` in the `curl | bash` below fails the build
# instead of being masked by the last stage's exit code.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Bun from its GitHub release zip. We don't need bun for Playwright (which
# ships its Node), but the renderer's own HTTP server runs under Bun for
# stack consistency. The zip needs `unzip`, which the Playwright base image
# doesn't ship. Pinned to the same Bun as the oven/bun images + CI
# (`bun-version`) so all three move together, and checked against the
# SHA-256 from the release's SHASUMS256.txt before anything in it runs (the
# old `curl | bash` installer ran whatever the server sent). Bumping Bun
# means updating BUN_VERSION and both checksums. The binary lives outside
# /root so the unprivileged runtime user can execute it.
#
# The base image's global npm (+ npx) is removed: nothing here uses it
# (deps install with bun), and its vendored node_modules carry fixable
# HIGH CVEs that the CI image scan would otherwise flag on every build.
# `apt` itself is upgraded: the pinned base image trails a fixed HIGH CVE
# in it that the image scan gates on.
# Firefox and WebKit are removed too: only Chromium is ever launched, and
# every browser left in the image is attack surface and image weight.
ARG TARGETARCH=amd64
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256_AMD64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && apt-get install -y --no-install-recommends --only-upgrade apt libapt-pkg6.0 \
 && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH}" in \
      amd64) bun_asset=bun-linux-x64; bun_sha256="${BUN_SHA256_AMD64}" ;; \
      arm64) bun_asset=bun-linux-aarch64; bun_sha256="${BUN_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bun_asset}.zip" \
 && echo "${bun_sha256}  /tmp/bun.zip" | sha256sum -c - \
 && mkdir -p /opt/bun/bin \
 && unzip -j -o /tmp/bun.zip "${bun_asset}/bun" -d /opt/bun/bin \
 && chmod 0755 /opt/bun/bin/bun \
 && rm -f /tmp/bun.zip \
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

# Tiny, no-deps healthcheck: wget ships in the Playwright base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:9000/health || exit 1

CMD ["bun", "run", "src/index.ts"]
