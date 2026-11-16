#!/usr/bin/env bash
# Static checks for the self-host deployment shape (CI: `selfhost-check` job).
#
#   bash scripts/selfhost-check.sh
#
# 1. shellcheck install.sh (and this script).
# 2. `docker compose config` for every supported COMPOSE_FILE combination,
#    against a throwaway env file with placeholder values: catches YAML
#    errors, missing `${VAR:?}` wiring and broken overlays without starting
#    anything.
# 3. The rendered config must not leak the hosted operator defaults into a
#    self-hosted instance (legal surfaces off by default).
# 4. Backup sidecar credentials + cron path.
# 5. Network segmentation and the container hardening baseline for the
#    selfhost / prod / local stacks; dev + test publish on loopback only.
# 6. Service-to-service routes are not routed by the public Traefik
#    routers, and markitdown requires its shared secret.
# 7. Layout: every stack under deploy/compose/, seccomp paths resolve, and
#    the host deploy paths sync every file the prod stack mounts.
# 8. The hosted shape (prod + the Podman overlay, rootless Podman): the
#    edge relay, Traefik on loopback with PROXY protocol trust limited to its
#    own networks, the bundled Postgres only behind its profile.
set -euo pipefail

cd "$(dirname "$0")/.."

shellcheck install.sh scripts/selfhost-check.sh scripts/test-compose.sh infra/render-env.sh infra/render-env-test.sh

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/selfhost.env" <<'EOF'
MARKOTO_INSTANCE=markoto-ci
MARKOTO_PUBLIC_URL=https://docs.example.org
MARKOTO_SYNC_URL=wss://docs.example.org/sync
MARKOTO_DOMAIN=docs.example.org
ACME_EMAIL=ops@example.org
POSTGRES_USER=markoto
POSTGRES_PASSWORD=placeholder
POSTGRES_DB=markoto
VALKEY_PASSWORD=placeholder
NUXT_SESSION_PASSWORD=placeholder-placeholder-placeholder-00
NUXT_JWT_SECRET=placeholder-placeholder-placeholder-000000
NUXT_INTERNAL_API_SECRET=placeholder-placeholder-placeholder-0000
NUXT_MARKITDOWN_API_SECRET=placeholder-placeholder-placeholder-0000
NUXT_ENCRYPTION_KEY=placeholder-encryption-placeholder-0000
NUXT_S3_ACCESS_KEY=placeholder
NUXT_S3_SECRET_KEY=placeholder
NUXT_S3_BUCKET=markoto-files
LITELLM_MASTER_KEY=sk-placeholder
LITELLM_SALT_KEY=sk-placeholder
BACKUP_GPG_PASSPHRASE=placeholder
EOF

check() {
  local label="$1" files="$2" profiles="${3:-}"
  local out="$tmp/config.yml"
  if ! COMPOSE_FILE="$files" COMPOSE_PROFILES="$profiles" \
      docker compose --env-file "$tmp/selfhost.env" -p markoto-ci config > "$out"; then
    echo "FAIL: docker compose config ($label)" >&2
    exit 1
  fi
  if grep -q 'NUXT_LEGAL_SURFACES_ENABLED: "true"' "$out"; then
    echo "FAIL: legal surfaces must default to off for self-hosting ($label)" >&2
    exit 1
  fi
  # The anonymous gate follows the legal surfaces unless the operator opts in.
  if grep -q 'NUXT_ANON_GATE_ENABLED: "true"' "$out"; then
    echo "FAIL: the anonymous gate must not default to on for self-hosting ($label)" >&2
    exit 1
  fi
  # The marketing site (product tour, sitemap, JSON-LD) is markoto.app's own.
  if grep -Eq 'NUXT_(MARKETING_SITE|PRODUCT_TOUR)_ENABLED: "?true' "$out"; then
    echo "FAIL: the marketing site must not be on for self-hosting ($label)" >&2
    exit 1
  fi
  # Bundled /docs pages point their canonical at markoto.app by default.
  if ! grep -q 'NUXT_DOCS_CANONICAL_BASE: https://markoto.app' "$out"; then
    echo "FAIL: NUXT_DOCS_CANONICAL_BASE must default to https://markoto.app ($label)" >&2
    exit 1
  fi
  echo "ok: $label"
}

check "http" "deploy/compose/compose.selfhost.yml"
check "http + backup" "deploy/compose/compose.selfhost.yml" "backup"
check "tls" "deploy/compose/compose.selfhost.yml:deploy/compose/compose.selfhost.tls.yml"
check "tls + build + backup" "deploy/compose/compose.selfhost.yml:deploy/compose/compose.selfhost.tls.yml:deploy/compose/compose.selfhost.build.yml" "backup"
check "http + build" "deploy/compose/compose.selfhost.yml:deploy/compose/compose.selfhost.build.yml"
check "tls + brand" "deploy/compose/compose.selfhost.yml:deploy/compose/compose.selfhost.tls.yml:deploy/compose/compose.selfhost.brand.yml"

# Backup sidecar
# 1. Backup credentials (BACKUP_S3_*) reach the backup service only: the app
#    and the renderer must never see them, in any compose file.
cat >> "$tmp/selfhost.env" <<'EOF2'
BACKUP_S3_ENDPOINT=https://backup-s3.example.org
BACKUP_S3_BUCKET=backup-only-bucket
BACKUP_S3_ACCESS_KEY=backup-only-access-key
BACKUP_S3_SECRET_KEY=backup-only-secret-key
EOF2
COMPOSE_FILE="deploy/compose/compose.selfhost.yml" COMPOSE_PROFILES="backup" \
  docker compose --env-file "$tmp/selfhost.env" -p markoto-ci config --format json > "$tmp/config.json"
for svc in app sync renderer markitdown; do
  if jq -e --arg s "$svc" '.services[$s].environment // {} | tostring | test("backup-only")' "$tmp/config.json" > /dev/null; then
    echo "FAIL: backup credentials leaked into the $svc service" >&2
    exit 1
  fi
done
if ! jq -e '.services.backup.environment | .S3_ACCESS_KEY == "backup-only-access-key" and .S3_BUCKET == "backup-only-bucket"' \
    "$tmp/config.json" > /dev/null; then
  echo "FAIL: BACKUP_S3_* must configure the backup service" >&2
  exit 1
fi
echo "ok: backup credentials reach only the backup service"

# 2. The nightly backup timer must call a script that exists, and be executable
#    by the unprivileged user the image runs as. Build the real image and
#    resolve the exact path the timer task uses.
cron_path="$(grep -oE 'exec -T backup [^ ]+' infra/roles/backup_timer/tasks/main.yml | awk '{print $4}' | head -n 1)"
if [[ -z "$cron_path" ]]; then
  echo "FAIL: could not find the backup command in infra/roles/backup_timer/tasks/main.yml" >&2
  exit 1
fi
docker build --load -q -t localhost/markoto-backup-ci backup-server > /dev/null
if [[ "$(docker run --rm --entrypoint id localhost/markoto-backup-ci -u)" = "0" ]]; then
  echo "FAIL: the backup image must not run as root" >&2
  exit 1
fi
if ! docker run --rm --entrypoint sh localhost/markoto-backup-ci -c "test -f '$cron_path' && test -x '$cron_path' && sh -n '$cron_path'"; then
  echo "FAIL: the cron command '$cron_path' is not an executable script in the backup image" >&2
  exit 1
fi
echo "ok: cron command $cron_path exists in the backup image (non-root)"

# Container + network isolation (docs/SECURITY-HARDENING.md)
# Rendered against placeholder values for every stack that runs the
# product: selfhost (all overlays), prod, local. The rules:
#   - the renderer and markitdown (they parse untrusted input) share no
#     network with postgres / valkey / litellm / sync / db-init;
#   - only app / renderer / backup / s3-init / traefik share a network with
#     the bundled SeaweedFS;
#   - nothing but the socket proxy mounts the Docker socket;
#   - every service drops all capabilities and sets no-new-privileges;
#   - the renderer, markitdown, litellm, valkey, sync, app and traefik run
#     on a read-only root filesystem; the renderer keeps Chromium's sandbox
#     (custom seccomp profile, never --no-sandbox);
#   - the LiteLLM admin UI is off.
cat > "$tmp/prod.env" <<'EOF3'
DOMAIN=docs.example.org
ACME_EMAIL=ops@example.org
REGISTRY=ghcr.io/example
IMAGE_TAG=v0.0.0
POSTGRES_USER=markoto
POSTGRES_PASSWORD=placeholder
POSTGRES_DB=markoto
POSTGRES_PORT=5432
VALKEY_PASSWORD=placeholder
VALKEY_DB=0
VALKEY_PORT=6379
NUXT_SESSION_PASSWORD=placeholder-placeholder-placeholder-00
NUXT_JWT_SECRET=placeholder-placeholder-placeholder-000000
NUXT_INTERNAL_API_SECRET=placeholder-placeholder-placeholder-0000
NUXT_MARKITDOWN_API_SECRET=placeholder-placeholder-placeholder-0000
NUXT_ENCRYPTION_KEY=placeholder-encryption-placeholder-0000
NUXT_S3_ENDPOINT=https://s3.example.org
NUXT_S3_ACCESS_KEY=placeholder
NUXT_S3_SECRET_KEY=placeholder
NUXT_S3_BUCKET=markoto-files
NUXT_AI_BYOK_ALLOWED_BASE_URLS=https://api.example.org/v1
LITELLM_MASTER_KEY=sk-placeholder
LITELLM_SALT_KEY=sk-placeholder
BACKUP_GPG_PASSPHRASE=placeholder
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_COUNT=14
NUXT_ALTCHA_HMAC_KEY=placeholder-placeholder-placeholder-0000
NUXT_PUBLISH_PAGES_HOST=pages.docs.example.org
CONTAINER_SOCKET=/run/user/1001/podman/podman.sock
EOF3

render_config() { # render_config OUT ENVFILE FILES [PROFILES]
  # Unset optional vars warn on stderr; show that only if rendering fails.
  if ! COMPOSE_FILE="$3" COMPOSE_PROFILES="${4:-}" \
      docker compose --env-file "$2" -p markoto-ci config --format json > "$1" 2> "$tmp/config.err"; then
    cat "$tmp/config.err" >&2
    echo "FAIL: docker compose config ($3)" >&2
    exit 1
  fi
}

check_isolation() { # check_isolation LABEL CONFIG_JSON
  local label="$1" cfg="$2" out
  out="$(jq -r '
    def members($n): [.services | to_entries[] | select((.value.networks // {}) | has($n)) | .key];
    def nets($s): ((.services[$s].networks // {}) | keys);
    . as $c
    | [
        # untrusted-input parsers vs the data plane
        ( ["renderer", "markitdown"][] as $s | select($c.services[$s])
          | ($c | nets($s))[] as $n
          | ($c | members($n))[] as $m
          | select(["postgres", "valkey", "litellm", "sync", "db-init"] | index($m))
          | "\($s) shares network \($n) with \($m)" ),
        # who may reach the bundled object storage
        ( select($c.services.seaweedfs) | ($c | nets("seaweedfs"))[] as $n
          | ($c | members($n))[] as $m
          | select(["seaweedfs", "app", "renderer", "backup", "s3-init", "traefik"] | index($m) | not)
          | "\($m) shares network \($n) with seaweedfs" ),
        # the Docker socket
        ( .services | to_entries[] | select(.key != "socket-proxy")
          | select([.value.volumes[]? | .source // "" | test("(docker|podman)\\.sock")] | any)
          | "\(.key) mounts the Docker socket" ),
        # capabilities + no-new-privileges, everywhere
        ( .services | to_entries[]
          | select(((.value.cap_drop // []) | index("ALL")) == null)
          | "\(.key) does not drop all capabilities" ),
        ( .services | to_entries[]
          | select(((.value.security_opt // []) | index("no-new-privileges:true")) == null)
          | "\(.key) lacks no-new-privileges" ),
        # read-only root filesystems
        ( ["renderer", "markitdown", "litellm", "valkey", "sync", "app", "traefik", "socket-proxy"][] as $s
          | select($c.services[$s]) | select($c.services[$s].read_only != true)
          | "\($s) has a writable root filesystem" ),
        # Chromium sandbox profile
        ( select(.services.renderer)
          | select(((.services.renderer.security_opt // []) | map(select(startswith("seccomp="))) | length) == 0)
          | "renderer has no seccomp profile (Chromium sandbox)" ),
        # LiteLLM admin UI
        ( select(.services.litellm) | select(.services.litellm.environment.DISABLE_ADMIN_UI != "True")
          | "litellm admin UI is not disabled" )
      ]
    | .[]' "$cfg")"
  if [[ -n "$out" ]]; then
    printf 'FAIL (%s): %s\n' "$label" "$out" >&2
    exit 1
  fi
  echo "ok: isolation + hardening ($label)"
}

for combo in \
  "selfhost|deploy/compose/compose.selfhost.yml|backup" \
  "selfhost tls|deploy/compose/compose.selfhost.yml:deploy/compose/compose.selfhost.tls.yml|backup" \
  "selfhost build|deploy/compose/compose.selfhost.yml:deploy/compose/compose.selfhost.build.yml|backup"; do
  IFS='|' read -r label files profiles <<< "$combo"
  render_config "$tmp/iso.json" "$tmp/selfhost.env" "$files" "$profiles"
  check_isolation "$label" "$tmp/iso.json"
done
render_config "$tmp/iso.json" "$tmp/prod.env" "deploy/compose/compose.prod.yml"
check_isolation "prod" "$tmp/iso.json"

# Anonymous gate (shared/config/anonGate.ts)
# Hosted: on, and the ALTCHA key is required (compose refuses without it).
# Self-host: install.sh generates the key on install AND upgrade.
if ! jq -e '.services.app.environment.NUXT_ANON_GATE_ENABLED == "true"' "$tmp/iso.json" > /dev/null; then
  echo "FAIL: prod must gate anonymous use (NUXT_ANON_GATE_ENABLED=true)" >&2
  exit 1
fi
grep -v '^NUXT_ALTCHA_HMAC_KEY=' "$tmp/prod.env" > "$tmp/prod-nokey.env"
if COMPOSE_FILE="deploy/compose/compose.prod.yml" docker compose --env-file "$tmp/prod-nokey.env" -p markoto-ci config > /dev/null 2>&1; then
  echo "FAIL: prod compose must require NUXT_ALTCHA_HMAC_KEY" >&2
  exit 1
fi
if [[ "$(grep -c 'ensure_secret NUXT_ALTCHA_HMAC_KEY hex' install.sh)" -lt 2 ]]; then
  echo "FAIL: install.sh must generate NUXT_ALTCHA_HMAC_KEY on install and upgrade" >&2
  exit 1
fi
echo "ok: anonymous gate wiring (prod on + key required, self-host key generated)"
# Markitdown refuses unauthenticated requests: an existing install that
# upgrades must get the secret generated too, not only a fresh one.
if [[ "$(grep -c 'ensure_secret NUXT_MARKITDOWN_API_SECRET hex' install.sh)" -lt 2 ]]; then
  echo "FAIL: install.sh must generate NUXT_MARKITDOWN_API_SECRET on install and upgrade" >&2
  exit 1
fi
echo "ok: install.sh generates the markitdown secret (install + upgrade)"
render_config "$tmp/local.json" "$tmp/prod.env" "deploy/compose/compose.local.yml"
check_isolation "local" "$tmp/local.json"

# App gets its own encryption key, not LiteLLM's salt
# The app encrypts the secrets it stores (virtual keys, BYOK keys, SSO
# secrets) with NUXT_ENCRYPTION_KEY. Every compose shape that runs the app
# must pass it (a key reaching only one service once failed every AI setup
# on staging), and LiteLLM's salt stays with LiteLLM: a compromised proxy
# container must not hold the key to the app's stored credentials.
render_config "$tmp/salt-prod.json" "$tmp/prod.env" "deploy/compose/compose.prod.yml"
render_config "$tmp/salt-selfhost.json" "$tmp/selfhost.env" "deploy/compose/compose.selfhost.yml"
for cfg in salt-prod salt-selfhost local; do
  if ! jq -e '(.services.app.environment.NUXT_ENCRYPTION_KEY // "") != "" and .services.app.environment.LITELLM_SALT_KEY == null and .services.litellm.environment.LITELLM_SALT_KEY != null' "$tmp/$cfg.json" > /dev/null; then
    echo "FAIL: the app must receive NUXT_ENCRYPTION_KEY and not LITELLM_SALT_KEY ($cfg)" >&2
    exit 1
  fi
done
grep -v '^NUXT_ENCRYPTION_KEY=' "$tmp/prod.env" > "$tmp/prod-noenc.env"
if COMPOSE_FILE="deploy/compose/compose.prod.yml" docker compose --env-file "$tmp/prod-noenc.env" -p markoto-ci config > /dev/null 2>&1; then
  echo "FAIL: prod compose must require NUXT_ENCRYPTION_KEY" >&2
  exit 1
fi
if [[ "$(grep -c 'ensure_secret NUXT_ENCRYPTION_KEY hex' install.sh)" -lt 2 ]]; then
  echo "FAIL: install.sh must generate NUXT_ENCRYPTION_KEY on install and upgrade" >&2
  exit 1
fi
echo "ok: the app gets its own encryption key (prod, self-host, local; generated on install + upgrade)"

# Third-party images are pinned by version tag + digest
# A tag can be re-pushed; `tag@sha256:…` can't. The tag names the version
# for humans and Dependabot: no bare digests, no floating `latest` / major
# tags. Our own images (${REGISTRY}/markoto-*) are pinned by release tag and
# cosign-signed.
render_config "$tmp/img-dev.json" "$tmp/prod.env" "deploy/compose/compose.dev.yml"
render_config "$tmp/img-test.json" "$tmp/prod.env" "deploy/compose/compose.test.yml" "flows"
pinned_re='^[^@]+:[^/@:]*[0-9][^/@:]*[.][0-9][^/@:]*@sha256:[0-9a-f]{64}$'
for cfg in salt-prod salt-selfhost local img-dev img-test; do
  out="$(jq -r --arg re "$pinned_re" '.services | to_entries[] | select(.value.image != null) | .value.image
    | select((test("/markoto-[a-z]+:") | not) and (test($re) | not))' "$tmp/$cfg.json")"
  if [[ -n "$out" ]]; then
    printf 'FAIL (%s): image not pinned by version tag + digest: %s\n' "$cfg" "$out" >&2
    exit 1
  fi
done
for df in Dockerfile sync-server/Dockerfile renderer/Dockerfile markitdown-server/Dockerfile backup-server/Dockerfile; do
  if grep -E '^FROM ' "$df" | grep -vE '^FROM [a-z]+ AS ' | awk '{print $2}' | grep -vE "$pinned_re" | grep -q .; then
    echo "FAIL: $df has a FROM without a version tag + digest" >&2
    exit 1
  fi
done
echo "ok: third-party images pinned by version tag + digest (compose + Dockerfiles)"

# Postgres 18 keeps its cluster under /var/lib/postgresql/18/docker and
# refuses a mount at the pre-18 /var/lib/postgresql/data: every stack mounts
# the data volume (or tmpfs) one level up, and every deploy path moves an
# old cluster over first (deploy/config/postgres/pg-major-upgrade.sh).
for cfg in salt-prod salt-selfhost local img-dev img-test; do
  out="$(jq -r '.services | to_entries[] | select(.value.image // "" | test("^(docker.io/)?pgvector/pgvector:")) | select(.value.entrypoint == null)
    | .key as $k
    | ( (.value.volumes // [] | map(select(.target | startswith("/var/lib/postgresql"))) | map(.target))
        + ((.value.tmpfs // []) | map(select(startswith("/var/lib/postgresql")) | split(":")[0])) ) as $t
    | select($t != ["/var/lib/postgresql"]) | "\($k) mounts \($t)"' "$tmp/$cfg.json")"
  if [[ -n "$out" ]]; then
    printf 'FAIL (%s): Postgres data must be mounted at /var/lib/postgresql: %s\n' "$cfg" "$out" >&2
    exit 1
  fi
done
shellcheck deploy/config/postgres/pg-major-upgrade.sh
for f in .github/workflows/deploy.yml infra/roles/markoto/tasks/main.yml; do
  if [[ "$(grep -c 'deploy/config/postgres/pg-major-upgrade.sh' "$f")" -lt 2 ]]; then
    echo "FAIL: $f must ship and run deploy/config/postgres/pg-major-upgrade.sh" >&2
    exit 1
  fi
done
if ! grep -q 'require_current_postgres' install.sh || ! grep -q 'pg-major-upgrade.sh' install.sh; then
  echo "FAIL: install.sh must refuse a pre-18 Postgres volume and offer upgrade-postgres" >&2
  exit 1
fi
echo "ok: Postgres 18 data layout (mounts at /var/lib/postgresql; deploy paths move an old cluster over)"

# App and sync server key their rate limits on the same X-Forwarded-For
# entry only while both get the same trusted-proxy hop count.
for cfg in salt-prod salt-selfhost; do
  if ! jq -e '.services.app.environment.NUXT_TRUSTED_PROXY_HOPS != null and .services.app.environment.NUXT_TRUSTED_PROXY_HOPS == .services.sync.environment.TRUSTED_PROXY_HOPS' "$tmp/$cfg.json" > /dev/null; then
    echo "FAIL: app NUXT_TRUSTED_PROXY_HOPS and sync TRUSTED_PROXY_HOPS must match ($cfg)" >&2
    exit 1
  fi
done
echo "ok: app and sync agree on the trusted proxy hops (prod, self-host)"

# LiteLLM is recreated when its config changes
# LiteLLM reads its config once at boot and the single-file bind mounts
# keep the old file after a deploy replaced it (staging ran a week-old
# model list). The deploy paths export LITELLM_CONFIG_HASH; the label must
# carry it so `compose up -d` recreates the container.
LITELLM_CONFIG_HASH=ci-hash-1 render_config "$tmp/hash-prod.json" "$tmp/prod.env" "deploy/compose/compose.prod.yml"
LITELLM_CONFIG_HASH=ci-hash-1 render_config "$tmp/hash-selfhost.json" "$tmp/selfhost.env" "deploy/compose/compose.selfhost.yml"
for cfg in hash-prod hash-selfhost; do
  if ! jq -e '.services.litellm.labels["markoto.litellm-config"] == "ci-hash-1"' "$tmp/$cfg.json" > /dev/null; then
    echo "FAIL: the litellm service must carry LITELLM_CONFIG_HASH as its markoto.litellm-config label ($cfg)" >&2
    exit 1
  fi
done
for f in .github/workflows/deploy.yml install.sh infra/roles/markoto/tasks/main.yml; do
  if ! grep -q 'LITELLM_CONFIG_HASH' "$f"; then
    echo "FAIL: $f must export LITELLM_CONFIG_HASH before compose up" >&2
    exit 1
  fi
done
echo "ok: litellm is recreated when its config changes (prod, self-host)"

# The renderer code must never launch Chromium without its sandbox, and the
# profile must keep the one rule the sandbox needs.
if grep -rn -- '--no-sandbox' renderer/src; then
  echo "FAIL: renderer/src passes --no-sandbox to Chromium" >&2
  exit 1
fi
if ! jq -e '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and ((.includes // {}) | length) == 0 and ((.names | index("unshare")) != null))] | length == 1' deploy/config/renderer/seccomp.json > /dev/null; then
  echo "FAIL: deploy/config/renderer/seccomp.json must allow unshare unconditionally (Chromium user-namespace sandbox)" >&2
  exit 1
fi
echo "ok: renderer keeps Chromium's sandbox"

# Internal routes stay off the public edge
# The app's /api/internal/** (sync → app), the renderer's print page +
# bootstrap and the sync server's /internal/** control plane are reached
# over the Docker network only. Every public router that could match them
# must exclude them; a catch-all that carries the exclusions is longer than
# the routers it must yield to, so it needs the explicit lowest priority.
check_internal_routes() { # check_internal_routes LABEL CONFIG_JSON
  local out
  out="$(jq -r '
    def routers($s): (.services[$s].labels // {}) | to_entries
      | map(select(.key | test("^traefik\\.http\\.routers\\.[^.]+\\.rule$")))
      | map({ name: (.key | split(".")[3]), rule: .value });
    . as $c
    | [
        ( routers("app")[]
          # A router with a positive path matcher other than `/` (the
          # Path(`/api/import`) body-limit router) cannot match internal paths.
          | select(.rule | gsub("!Path(Prefix)?\\([^)]*\\)"; "") | test("PathPrefix\\(`/`\\)") or (test("Path") | not))
          | . as $r
          | ( ["!PathPrefix(`/api/internal/`)", "!PathPrefix(`/_internal/render/`)", "!Path(`/api/_internal/render-bootstrap`)"][]
              | select(. as $x | $r.rule | contains($x) | not)
              | "app router \($r.name) does not exclude \(.)" ),
            ( select(($c.services.app.labels["traefik.http.routers.\($r.name).priority"] // "") != "1")
              | "app router \($r.name) needs priority 1 (its exclusions make it outrank narrower routers)" ) ),
        ( routers("sync")[]
          | (if (.rule | contains("PathPrefix(`/sync`)")) then "!PathPrefix(`/sync/internal/`)" else "!PathPrefix(`/internal/`)" end) as $x
          | select(.rule | contains($x) | not)
          | "sync router \(.name) does not exclude \($x)" ),
        ( select($c.services.markitdown)
          | select(($c.services.markitdown.environment.MARKITDOWN_API_SECRET // "") == "")
          | "markitdown has no MARKITDOWN_API_SECRET" ),
        ( select($c.services.markitdown)
          | select($c.services.markitdown.environment.MARKITDOWN_API_SECRET != $c.services.app.environment.NUXT_MARKITDOWN_API_SECRET)
          | "the app and markitdown disagree on the markitdown secret" )
      ]
    | .[]' "$2")"
  if [[ -n "$out" ]]; then
    printf 'FAIL (%s): %s\n' "$1" "$out" >&2
    exit 1
  fi
  echo "ok: internal routes stay off the public edge ($1)"
}
render_config "$tmp/edge-selfhost.json" "$tmp/selfhost.env" "deploy/compose/compose.selfhost.yml"
check_internal_routes "selfhost" "$tmp/edge-selfhost.json"
render_config "$tmp/edge-selfhost-tls.json" "$tmp/selfhost.env" "deploy/compose/compose.selfhost.yml:deploy/compose/compose.selfhost.tls.yml"
check_internal_routes "selfhost tls" "$tmp/edge-selfhost-tls.json"
check_internal_routes "prod" "$tmp/salt-prod.json"
check_internal_routes "local" "$tmp/local.json"

# Published pages on their own host
# User-written HTML never shares the app's origin. The pages-host router
# admits only a published page's paths (never `/`, never an internal
# route); the app 404s anything else there too. Hosted: required (compose
# refuses without it). Self-host HTTPS: optional, routed through the HTTP
# provider, so the overlay must switch that router on.
# shellcheck disable=SC2016 # Traefik rule syntax, backticks are literal
pages_paths='(PathPrefix(`/p/`) || PathPrefix(`/api/published/`) || PathPrefix(`/vendor/`) || Path(`/robots.txt`) || Path(`/favicon.ico`))'
check_pages_router() { # check_pages_router LABEL CONFIG_JSON HOST
  local rule
  rule="$(jq -r '.services.app.labels["traefik.http.routers.pages.rule"] // ""' "$2")"
  if [[ "$rule" != "Host(\`$3\`) && $pages_paths" ]]; then
    printf 'FAIL (%s): pages router rule is "%s"\n' "$1" "$rule" >&2
    exit 1
  fi
}
check_pages_router "prod" "$tmp/salt-prod.json" "pages.docs.example.org"
check_pages_router "local" "$tmp/local.json" "pages.ypad.127.0.0.1.nip.io"
if ! jq -e '.services.app.environment.NUXT_PUBLISH_PAGES_HOST == "pages.docs.example.org"' "$tmp/salt-prod.json" > /dev/null; then
  echo "FAIL: prod must pass NUXT_PUBLISH_PAGES_HOST to the app" >&2
  exit 1
fi
grep -v '^NUXT_PUBLISH_PAGES_HOST=' "$tmp/prod.env" > "$tmp/prod-nopages.env"
if COMPOSE_FILE="deploy/compose/compose.prod.yml" docker compose --env-file "$tmp/prod-nopages.env" -p markoto-ci config > /dev/null 2>&1; then
  echo "FAIL: prod compose must require NUXT_PUBLISH_PAGES_HOST" >&2
  exit 1
fi
if ! jq -e '.services.app.environment.NUXT_PUBLISH_TRAEFIK_PAGES_ROUTER == "true"' "$tmp/edge-selfhost-tls.json" > /dev/null; then
  echo "FAIL: the self-host HTTPS overlay must ask the HTTP provider for the pages-host router" >&2
  exit 1
fi
# Prod declares the router as a label; a second one from the provider would
# race it for the host and its certificate.
for cfg in edge-selfhost salt-prod; do
  if jq -e '.services.app.environment.NUXT_PUBLISH_TRAEFIK_PAGES_ROUTER != null' "$tmp/$cfg.json" > /dev/null; then
    echo "FAIL: only the self-host HTTPS overlay asks the HTTP provider for the pages-host router ($cfg)" >&2
    exit 1
  fi
done
pages_inner="${pages_paths#(}"
if ! grep -qF "${pages_inner%)}" server/utils/customDomains/traefikConfig.ts; then
  echo "FAIL: the HTTP-provider pages router must admit the same paths as the compose routers" >&2
  exit 1
fi
echo "ok: published pages have their own host (prod required, local, self-host HTTPS via provider)"

# Dev + test stacks publish on loopback only
# Throwaway credentials (devpassword, the committed deploy/config/seaweedfs/s3.json keys)
# must never be reachable from the LAN. The only other binding allowed is
# the test network's gateway address for fake-openai-test (see
# deploy/compose/compose.test.yml).
check_loopback() { # check_loopback LABEL CONFIG_JSON
  local out
  # Exception: fake-openai-test (BYOK) and oidc-test (per-workspace SSO
  # mock IdP) are also published on the test network's gateway
  # (10.213.47.x), or on TEST_FAKE_OPENAI_HOST (rootless Podman,
  # docs/contributing/CONTAINER-ENGINES.md): the app refuses loopback provider / IdP
  # URLs, so they must sit on a private address it and the containers reach.
  out="$(jq -r --arg fakehost "${TEST_FAKE_OPENAI_HOST:-}" '
    .services | to_entries[] | .key as $s | (.value.ports // [])[]
    | select((.host_ip // "") as $ip | ($ip != "127.0.0.1") and ((($s == "fake-openai-test" or $s == "oidc-test") and (($ip | startswith("10.213.47.")) or ($fakehost != "" and $ip == $fakehost))) | not))
    | "\($s) publishes \(.published) on \(.host_ip // "all interfaces")"' "$2")"
  if [[ -n "$out" ]]; then
    printf 'FAIL (%s): %s\n' "$1" "$out" >&2
    exit 1
  fi
  echo "ok: $1 publishes on loopback only"
}
render_config "$tmp/dev.json" "$tmp/prod.env" "deploy/compose/compose.dev.yml"
check_loopback "dev" "$tmp/dev.json"
render_config "$tmp/test.json" "$tmp/prod.env" "deploy/compose/compose.test.yml" "flows"
check_loopback "test" "$tmp/test.json"
check_loopback "local" "$tmp/local.json"

# Layout (deploy/compose, deploy/config)
# Every stack lives in deploy/compose/ and the third-party config it mounts
# in deploy/config/; nothing stays behind in the repository root.
stray="$(git ls-files ':(glob)docker-compose*.yml' ':(glob)compose*.y*ml' ':(glob)docker-compose*.yaml')"
if [[ -n "$stray" ]]; then
  echo "FAIL: compose files outside deploy/compose/: $stray" >&2
  exit 1
fi
# The Podman overlays render on top of their stacks too.
render_config "$tmp/podman-selfhost.json" "$tmp/selfhost.env" "deploy/compose/compose.selfhost.yml:deploy/compose/compose.podman.yml" "backup"
render_config "$tmp/podman-dev.json" "$tmp/prod.env" "deploy/compose/compose.dev.yml:deploy/compose/compose.podman.yml"
render_config "$tmp/podman-test.json" "$tmp/prod.env" "deploy/compose/compose.test.yml:deploy/compose/compose.test.podman.yml" "flows"
# Compose reads a seccomp profile at `up`, relative to the project
# directory (the compose files' own, deploy/compose/), not at `config`:
# a wrong path only shows when the stack starts. Resolve it here.
for cfg in salt-prod salt-selfhost local dev test; do
  for prof in $(jq -r '[.services[].security_opt // [] | .[] | select(startswith("seccomp=")) | ltrimstr("seccomp=")] | unique | .[]' "$tmp/$cfg.json"); do
    if [[ ! -f "deploy/compose/$prof" ]]; then
      echo "FAIL: seccomp profile $prof does not exist relative to deploy/compose/ ($cfg)" >&2
      exit 1
    fi
  done
done
# The host gets the production stack at the same relative paths
# (deploy.yml's tar sync, the Ansible role's copy): every repository file
# the prod stack bind-mounts must be in both lists. The ACME store
# (../../traefik/acme.json) is host state, created by the role.
root="$(pwd)"
for src in $(jq -r --arg root "$root/" '[.services[].volumes // [] | .[] | select(.type == "bind") | .source | select(startswith($root)) | ltrimstr($root)] | unique | .[]' "$tmp/salt-prod.json"); do
  [[ "$src" = "traefik/acme.json" ]] && continue
  if [[ ! -e "$src" ]]; then
    echo "FAIL: prod mounts $src, which is not in the repository" >&2
    exit 1
  fi
  # deploy/config/postgres/init only runs on a fresh data dir: Ansible-only.
  if [[ "$src" != "deploy/config/postgres/init" ]] && ! grep -qE "^\s+$src \\\\$" .github/workflows/deploy.yml; then
    echo "FAIL: .github/workflows/deploy.yml does not sync $src to the host" >&2
    exit 1
  fi
  if [[ -f "$src" ]] && ! grep -qE "^\s+- $src$" infra/roles/markoto/tasks/main.yml; then
    echo "FAIL: infra/roles/markoto does not sync $src to the host" >&2
    exit 1
  fi
done
for f in deploy/compose/compose.prod.yml deploy/compose/compose.base.yml; do
  if ! grep -qE "^\s+$f \\\\$" .github/workflows/deploy.yml || ! grep -qE "^\s+- $f$" infra/roles/markoto/tasks/main.yml; then
    echo "FAIL: $f must be synced by deploy.yml and the Ansible role" >&2
    exit 1
  fi
done
echo "ok: layout (stacks in deploy/compose, seccomp paths resolve, the host gets every mounted file)"

# Hosted shape: prod on rootless Podman (infra/roles/podman_host)
# render-env.sh sets COMPOSE_FILE to prod + the Podman overlay and
# COMPOSE_PROFILES=bundled-postgres only for the in-stack Postgres.
render_config "$tmp/hosted.json" "$tmp/prod.env" "deploy/compose/compose.prod.yml:deploy/compose/compose.podman.yml"
render_config "$tmp/hosted-pg.json" "$tmp/prod.env" "deploy/compose/compose.prod.yml:deploy/compose/compose.podman.yml" "bundled-postgres"
for cfg in hosted hosted-pg; do
  out="$(jq -r '
    . as $c
    | def sub($n): ($c.networks[$n].ipam.config // [])[0].subnet // "unpinned";
      [
        # Only the TCP relay shares the host network namespace.
        ( .services | to_entries[] | select(.value.network_mode == "host" and .key != "edge-proxy")
          | "\(.key) uses the host network" ),
        ( select(.services["edge-proxy"].network_mode != "host") | "edge-proxy is not in the host network namespace" ),
        # Traefik is reachable only through the relay (loopback ports).
        ( .services.traefik.ports[]? | select(.host_ip != "127.0.0.1") | "traefik publishes \(.published) on \(.host_ip // "all interfaces")" ),
        # rootlessport presents Traefik own address on one of its networks:
        # the PROXY trust list must be exactly those pinned subnets.
        ( ([sub("web"), sub("docker-api")] | join(",")) as $want
          | .services.traefik.command[] | select(test("proxyProtocol.trustedIPs="))
          | select(split("=")[1] != $want) | "traefik trusts PROXY headers from \(split("=")[1]), expected \($want)" ),
        ( select([.services.traefik.command[] | select(test("entrypoints\\.(web|websecure)\\.proxyProtocol\\.trustedIPs="))] | length != 2)
          | "traefik must trust PROXY headers on both entrypoints" ),
        # The renderer: Podman default seccomp + CAP_SYS_CHROOT only.
        ( select((.services.renderer.cap_add // []) != ["SYS_CHROOT"]) | "renderer cap_add is \(.services.renderer.cap_add), expected [SYS_CHROOT]" ),
        ( .services.renderer.security_opt[]? | select(test("seccomp=unconfined|apparmor=unconfined")) | "renderer runs \(.)" ),
        # Every dependency on postgres tolerates its absence (managed cluster).
        ( .services | to_entries[] | select(.value.depends_on.postgres? and .value.depends_on.postgres.required != false)
          | "\(.key) requires postgres (must be required: false)" ),
        # The engine socket comes from markoto-compose.
        ( select([.services["socket-proxy"].volumes[] | select(.target == "/var/run/docker.sock") | .source] != ["/run/user/1001/podman/podman.sock"])
          | "socket-proxy does not mount CONTAINER_SOCKET" )
      ] | .[]' "$tmp/$cfg.json")"
  if [[ -n "$out" ]]; then
    printf 'FAIL (%s): %s\n' "$cfg" "$out" >&2
    exit 1
  fi
done
if jq -e '.services.postgres' "$tmp/hosted.json" > /dev/null; then
  echo "FAIL: the hosted stack must not run Postgres without the bundled-postgres profile" >&2
  exit 1
fi
if ! jq -e '.services.postgres' "$tmp/hosted-pg.json" > /dev/null; then
  echo "FAIL: the bundled-postgres profile must run the Postgres container" >&2
  exit 1
fi
check_isolation_hosted() { # the isolation rules minus the Docker seccomp file
  jq 'del(.services.renderer)' "$1" > "$tmp/hosted-norenderer.json"
  check_isolation "$2" "$tmp/hosted-norenderer.json"
}
check_isolation_hosted "$tmp/hosted-pg.json" "hosted (prod + podman)"
if ! grep -q "^COMPOSE_FILE=deploy/compose/compose.prod.yml:deploy/compose/compose.podman.yml$" infra/render-env.sh; then
  echo "FAIL: infra/render-env.sh must name the prod stack with the Podman overlay" >&2
  exit 1
fi
# The deploy paths sync the overlay and every file the hosted stack mounts.
for src in deploy/compose/compose.podman.yml $(jq -r --arg root "$root/" '[.services[].volumes // [] | .[] | select(.type == "bind") | .source | select(startswith($root)) | ltrimstr($root)] | unique | .[]' "$tmp/hosted-pg.json"); do
  case "$src" in traefik/acme.json|deploy/config/postgres/init) continue ;; esac
  if ! grep -qE "^\s+$src \\\\$" .github/workflows/deploy.yml || ! grep -qE "^\s+- $src$" infra/roles/markoto/tasks/main.yml; then
    echo "FAIL: $src must be synced by deploy.yml and the Ansible role" >&2
    exit 1
  fi
done
echo "ok: hosted shape (edge relay, loopback Traefik + PROXY trust, renderer on Podman, Postgres profile, synced files)"

# Edge capacity (docs/contributing/CONTAINER-ENGINES.md, "Edge sizing"):
#   - every ACME resolver requests ECDSA keys (an RSA-4096 handshake costs
#     about 40 ms of host CPU), and the deploy paths ship the script that
#     replaces certificates issued with RSA;
#   - Traefik and the app route on the liveness endpoint, which leaves sync
#     out, and sync is checked often enough to be routed seconds after a
#     restart;
#   - hosted: the edge relay caps connections and memory, Traefik has a
#     memory limit sized for that cap.
out="$(jq -r '
  .services.traefik.command as $cmd
  | [ $cmd[] | select(test("certificatesresolvers\\.[^.]+\\.acme\\.email=")) | capture("certificatesresolvers\\.(?<r>[^.]+)\\.") | .r ]
  | .[] as $r
  | select([$cmd[] | select(. == "--certificatesresolvers.\($r).acme.keytype=EC256")] | length == 0)
  | "resolver \($r) does not request EC256 keys"
' "$tmp/hosted.json" "$tmp/edge-selfhost-tls.json")"
if [[ -n "$out" ]]; then echo "FAIL: $out" >&2; exit 1; fi
for f in .github/workflows/deploy.yml infra/roles/markoto/tasks/main.yml; do
  if ! grep -q "deploy/config/traefik/acme-ec-migrate.sh" "$f"; then
    echo "FAIL: $f does not ship/run deploy/config/traefik/acme-ec-migrate.sh" >&2
    exit 1
  fi
done
if ! grep -q "acme-ec-migrate.sh" install.sh; then
  echo "FAIL: install.sh upgrade does not replace RSA certificates (acme-ec-migrate.sh)" >&2
  exit 1
fi
# The check must recognise ECDSA keys in both forms (Traefik 3.7 writes
# PKCS#8): a false "RSA" verdict rotates the store on every deploy and runs
# into Let's Encrypt's weekly certificate limit.
shellcheck deploy/config/traefik/acme-ec-migrate.sh deploy/config/traefik/acme-ec-migrate-test.sh
deploy/config/traefik/acme-ec-migrate-test.sh
for cfg in hosted salt-selfhost; do
  out="$(jq -r '
    ( .services.app.labels // {} | to_entries[] | select(.key | test("loadbalancer\\.healthcheck\\.path$")) | select(.value != "/api/health/live") | "\(.key)=\(.value): route on /api/health/live" ),
    ( .services.app.healthcheck.test // [] | join(" ") | select(test("/api/health(/live)?") and (test("/api/health/live") | not)) | "app container healthcheck must use /api/health/live" ),
    ( .services.sync.healthcheck.interval // "" | select(. != "" and (rtrimstr("s") | tonumber) > 5) | "sync healthcheck interval \(.) (Traefik routes a restarted sync only after it passes): keep it at 5s or less" )
  ' "$tmp/$cfg.json")"
  if [[ -n "$out" ]]; then printf 'FAIL (%s): %s\n' "$cfg" "$out" >&2; exit 1; fi
done
out="$(jq -r '
  ( select((.services.traefik.mem_limit // 0) == 0) | "traefik has no mem_limit" ),
  ( select((.services.traefik.environment.GOMEMLIMIT // "") == "") | "traefik has no GOMEMLIMIT" ),
  ( select((.services["edge-proxy"].mem_limit // 0) == 0) | "edge-proxy has no mem_limit" ),
  ( select((.services["edge-proxy"].command // [] | index("-m")) == null) | "edge-proxy runs without -m (HAProxy memory cap)" )
' "$tmp/hosted.json")"
if [[ -n "$out" ]]; then echo "FAIL (hosted): $out" >&2; exit 1; fi
if ! grep -qE '^\s+maxconn [0-9]+$' deploy/config/edge/haproxy.cfg; then
  echo "FAIL: deploy/config/edge/haproxy.cfg must set a global maxconn" >&2
  exit 1
fi
echo "ok: edge capacity (ECDSA certificates, liveness routing, sync health interval, edge + Traefik limits)"
