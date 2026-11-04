#!/usr/bin/env bash
# Static checks for the self-host deployment shape (CI: `selfhost-check` job).
#
#   bash scripts/selfhost-check.sh
#
# 1. shellcheck install.sh (and this script).
# 2. `docker compose config` for every supported COMPOSE_FILE combination,
#    against a throwaway env file with placeholder values — catches YAML
#    errors, missing `${VAR:?}` wiring and broken overlays without starting
#    anything.
# 3. The rendered config must not leak the hosted operator defaults into a
#    self-hosted instance (legal surfaces off by default).
# 4. Backup sidecar credentials + cron path.
# 5. Network segmentation and the container hardening baseline for the
#    selfhost / prod / local stacks; dev + test publish on loopback only.
set -euo pipefail

cd "$(dirname "$0")/.."

shellcheck install.sh scripts/selfhost-check.sh

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

check "http" "docker-compose.selfhost.yml"
check "http + backup" "docker-compose.selfhost.yml" "backup"
check "tls" "docker-compose.selfhost.yml:docker-compose.selfhost.tls.yml"
check "tls + build + backup" "docker-compose.selfhost.yml:docker-compose.selfhost.tls.yml:docker-compose.selfhost.build.yml" "backup"
check "http + build" "docker-compose.selfhost.yml:docker-compose.selfhost.build.yml"

# ─── Backup sidecar ───────────────────────────────────────────────────
# 1. Backup credentials (BACKUP_S3_*) reach the backup service only: the app
#    and the renderer must never see them, in any compose file.
cat >> "$tmp/selfhost.env" <<'EOF2'
BACKUP_S3_ENDPOINT=https://backup-s3.example.org
BACKUP_S3_BUCKET=backup-only-bucket
BACKUP_S3_ACCESS_KEY=backup-only-access-key
BACKUP_S3_SECRET_KEY=backup-only-secret-key
EOF2
COMPOSE_FILE="docker-compose.selfhost.yml" COMPOSE_PROFILES="backup" \
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

# 2. The nightly cron job must call a script that exists, and be executable
#    by the unprivileged user the image runs as. Build the real image and
#    resolve the exact path the cron task uses.
cron_path="$(grep -oE 'exec -T backup [^ ]+' infra/roles/backup_cron/tasks/main.yml | awk '{print $4}' | head -n 1)"
if [ -z "$cron_path" ]; then
  echo "FAIL: could not find the backup command in infra/roles/backup_cron/tasks/main.yml" >&2
  exit 1
fi
docker build -q -t markoto-backup-ci backup-server > /dev/null
if [ "$(docker run --rm --entrypoint id markoto-backup-ci -u)" = "0" ]; then
  echo "FAIL: the backup image must not run as root" >&2
  exit 1
fi
if ! docker run --rm --entrypoint sh markoto-backup-ci -c "test -f '$cron_path' && test -x '$cron_path' && sh -n '$cron_path'"; then
  echo "FAIL: the cron command '$cron_path' is not an executable script in the backup image" >&2
  exit 1
fi
echo "ok: cron command $cron_path exists in the backup image (non-root)"

# ─── Container + network isolation (docs/SECURITY-HARDENING.md) ───────
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
          | select([.value.volumes[]? | .source // "" | test("docker\\.sock")] | any)
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
  if [ -n "$out" ]; then
    printf 'FAIL (%s): %s\n' "$label" "$out" >&2
    exit 1
  fi
  echo "ok: isolation + hardening ($label)"
}

for combo in \
  "selfhost|docker-compose.selfhost.yml|backup" \
  "selfhost tls|docker-compose.selfhost.yml:docker-compose.selfhost.tls.yml|backup" \
  "selfhost build|docker-compose.selfhost.yml:docker-compose.selfhost.build.yml|backup"; do
  IFS='|' read -r label files profiles <<< "$combo"
  render_config "$tmp/iso.json" "$tmp/selfhost.env" "$files" "$profiles"
  check_isolation "$label" "$tmp/iso.json"
done
render_config "$tmp/iso.json" "$tmp/prod.env" "docker-compose.prod.yml"
check_isolation "prod" "$tmp/iso.json"

# ─── Anonymous gate (shared/config/anonGate.ts) ───────────────────────
# Hosted: on, and the ALTCHA key is required (compose refuses without it).
# Self-host: install.sh generates the key on install AND upgrade.
if ! jq -e '.services.app.environment.NUXT_ANON_GATE_ENABLED == "true"' "$tmp/iso.json" > /dev/null; then
  echo "FAIL: prod must gate anonymous use (NUXT_ANON_GATE_ENABLED=true)" >&2
  exit 1
fi
grep -v '^NUXT_ALTCHA_HMAC_KEY=' "$tmp/prod.env" > "$tmp/prod-nokey.env"
if COMPOSE_FILE="docker-compose.prod.yml" docker compose --env-file "$tmp/prod-nokey.env" -p markoto-ci config > /dev/null 2>&1; then
  echo "FAIL: prod compose must require NUXT_ALTCHA_HMAC_KEY" >&2
  exit 1
fi
if [ "$(grep -c 'ensure_secret NUXT_ALTCHA_HMAC_KEY hex' install.sh)" -lt 2 ]; then
  echo "FAIL: install.sh must generate NUXT_ALTCHA_HMAC_KEY on install and upgrade" >&2
  exit 1
fi
echo "ok: anonymous gate wiring (prod on + key required, self-host key generated)"
render_config "$tmp/local.json" "$tmp/prod.env" "docker-compose.local.yml"
check_isolation "local" "$tmp/local.json"

# ─── App gets the LiteLLM salt key ────────────────────────────────────
# The app encrypts users' LiteLLM virtual-key tokens with LITELLM_SALT_KEY.
# Every compose shape that runs the app must pass it (it reached only the
# litellm service once, and every AI setup on staging failed with a 500).
render_config "$tmp/salt-prod.json" "$tmp/prod.env" "docker-compose.prod.yml"
render_config "$tmp/salt-selfhost.json" "$tmp/selfhost.env" "docker-compose.selfhost.yml"
for cfg in salt-prod salt-selfhost local; do
  if ! jq -e '.services.app.environment.LITELLM_SALT_KEY == "sk-placeholder"' "$tmp/$cfg.json" > /dev/null; then
    echo "FAIL: the app service must receive LITELLM_SALT_KEY ($cfg)" >&2
    exit 1
  fi
done
echo "ok: the app receives LITELLM_SALT_KEY (prod, self-host, local)"

# ─── LiteLLM is recreated when its config changes ─────────────────────
# LiteLLM reads its config once at boot and the single-file bind mounts
# keep the old file after a deploy replaced it (staging ran a week-old
# model list). The deploy paths export LITELLM_CONFIG_HASH; the label must
# carry it so `compose up -d` recreates the container.
LITELLM_CONFIG_HASH=ci-hash-1 render_config "$tmp/hash-prod.json" "$tmp/prod.env" "docker-compose.prod.yml"
LITELLM_CONFIG_HASH=ci-hash-1 render_config "$tmp/hash-selfhost.json" "$tmp/selfhost.env" "docker-compose.selfhost.yml"
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
if ! jq -e '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and ((.includes // {}) | length) == 0 and ((.names | index("unshare")) != null))] | length == 1' renderer/seccomp.json > /dev/null; then
  echo "FAIL: renderer/seccomp.json must allow unshare unconditionally (Chromium user-namespace sandbox)" >&2
  exit 1
fi
echo "ok: renderer keeps Chromium's sandbox"

# ─── Dev + test stacks publish on loopback only ───────────────────────
# Throwaway credentials (devpassword, the committed seaweedfs/s3.json keys)
# must never be reachable from the LAN. The only other binding allowed is
# the test network's gateway address for fake-openai-test (see
# docker-compose.test.yml).
check_loopback() { # check_loopback LABEL CONFIG_JSON
  local out
  out="$(jq -r '
    .services | to_entries[] | .key as $s | (.value.ports // [])[]
    | select((.host_ip // "") as $ip | ($ip != "127.0.0.1") and (($s == "fake-openai-test" and ($ip | startswith("10.213.47."))) | not))
    | "\($s) publishes \(.published) on \(.host_ip // "all interfaces")"' "$2")"
  if [ -n "$out" ]; then
    printf 'FAIL (%s): %s\n' "$1" "$out" >&2
    exit 1
  fi
  echo "ok: $1 publishes on loopback only"
}
render_config "$tmp/dev.json" "$tmp/prod.env" "docker-compose.dev.yml"
check_loopback "dev" "$tmp/dev.json"
render_config "$tmp/test.json" "$tmp/prod.env" "docker-compose.test.yml" "flows"
check_loopback "test" "$tmp/test.json"
check_loopback "local" "$tmp/local.json"
