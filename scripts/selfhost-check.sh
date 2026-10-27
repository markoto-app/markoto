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
