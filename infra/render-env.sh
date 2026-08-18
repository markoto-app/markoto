#!/usr/bin/env bash
# Render /opt/markoto/.env from environment variables, for the CI-driven deploy
# (.github/workflows/deploy.yml). The workflow injects each value from GitHub
# Environment secrets/variables (+ repo-level provider-key secrets), whose NAMES
# are exactly the .env keys — so there is no ansible-var translation here.
#
# ⚠️  This is a faithful bash port of infra/templates/env.j2 (the ansible/laptop
#     path). The two MUST stay byte-identical for a given value set —
#     infra/render-env-parity-test.sh proves it. If you add a var to one, add
#     it to the other.
#
# Required vars fail loud (empty -> exit 1) so a broken render can never write a
# half-empty .env that the app then boots against.
set -euo pipefail

require() {  # require VAR_NAME
  local n="$1"
  if [ -z "${!n:-}" ]; then
    echo "render-env: required var '$n' is empty" >&2
    exit 1
  fi
}
for v in \
  NUXT_SESSION_PASSWORD NUXT_JWT_SECRET NUXT_INTERNAL_API_SECRET \
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
  VALKEY_PASSWORD \
  NUXT_S3_ENDPOINT NUXT_S3_ACCESS_KEY NUXT_S3_SECRET_KEY NUXT_S3_BUCKET \
  LITELLM_MASTER_KEY LITELLM_SALT_KEY \
  JINA_AI_API_KEY STAAN_API_KEY MISTRAL_API_KEY BFL_API_KEY \
  NUXT_STRIPE_SECRET_KEY NUXT_STRIPE_WEBHOOK_SECRET \
  NUXT_STRIPE_PRICE_PRO NUXT_STRIPE_PRICE_MAX NUXT_STRIPE_PRICE_ULTRA \
  BACKUP_GPG_PASSPHRASE \
  DOMAIN ACME_EMAIL REGISTRY IMAGE_TAG ; do
  require "$v"
done

# Non-secret defaults (env.j2 sources these from group_vars/all.yml).
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
VALKEY_DB="${VALKEY_DB:-0}"
VALKEY_TLS_ENABLED="${VALKEY_TLS_ENABLED:-false}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-30}"
# Managed-Postgres TLS: set OVH_PG_HOST + OVH_PG_CA_REMOTE_PATH to flip to
# cert-pinned TLS; empty (the in-stack pgvector default) disables TLS.
OVH_PG_HOST="${OVH_PG_HOST:-}"
OVH_PG_CA_REMOTE_PATH="${OVH_PG_CA_REMOTE_PATH:-/opt/markoto/secrets/ovh-pg-ca.pem}"

cat <<EOF
# markoto .env — rendered by CI (deploy.yml) from GitHub Environment secrets.
# Do not edit on the VPS; re-dispatch the deploy workflow after changing secrets.

# ─── App secrets ───
NUXT_SESSION_PASSWORD=${NUXT_SESSION_PASSWORD}
NUXT_JWT_SECRET=${NUXT_JWT_SECRET}
NUXT_INTERNAL_API_SECRET=${NUXT_INTERNAL_API_SECRET}
NUXT_JWT_SECRET_PREVIOUS=${NUXT_JWT_SECRET_PREVIOUS:-}
NUXT_INTERNAL_API_SECRET_PREVIOUS=${NUXT_INTERNAL_API_SECRET_PREVIOUS:-}

# ─── Postgres ───
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_HOST=${POSTGRES_HOST}
POSTGRES_PORT=${POSTGRES_PORT}

# ─── Valkey ───
VALKEY_HOST=valkey
VALKEY_PORT=6379
VALKEY_PASSWORD=${VALKEY_PASSWORD}
VALKEY_DB=${VALKEY_DB}
VALKEY_TLS_ENABLED=$(echo "$VALKEY_TLS_ENABLED" | tr '[:upper:]' '[:lower:]')

# ─── S3 / object storage ───
NUXT_S3_ENDPOINT=${NUXT_S3_ENDPOINT}
NUXT_S3_ACCESS_KEY=${NUXT_S3_ACCESS_KEY}
NUXT_S3_SECRET_KEY=${NUXT_S3_SECRET_KEY}
NUXT_S3_BUCKET=${NUXT_S3_BUCKET}

# ─── Internal service URLs (compose-network names) ───
NUXT_MARKITDOWN_URL=http://markitdown:8080
NUXT_SYNC_INTERNAL_URL=http://sync:4001
NUXT_PUBLIC_SYNC_URL=wss://sync.${DOMAIN}
NUXT_RENDERER_INTERNAL_URL=http://renderer:9000

# ─── AI dictate JWT ───
NUXT_AI_DICTATE_JWT_SECRET=${NUXT_AI_DICTATE_JWT_SECRET:-}

# ─── LiteLLM proxy ───
LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}
LITELLM_SALT_KEY=${LITELLM_SALT_KEY}

# ─── AI provider keys ───
JINA_AI_API_KEY=${JINA_AI_API_KEY}
STAAN_API_KEY=${STAAN_API_KEY}
MISTRAL_API_KEY=${MISTRAL_API_KEY}
BFL_API_KEY=${BFL_API_KEY}

# ─── Stripe billing ───
NUXT_STRIPE_SECRET_KEY=${NUXT_STRIPE_SECRET_KEY}
NUXT_STRIPE_WEBHOOK_SECRET=${NUXT_STRIPE_WEBHOOK_SECRET}
NUXT_STRIPE_PRICE_PRO=${NUXT_STRIPE_PRICE_PRO}
NUXT_STRIPE_PRICE_MAX=${NUXT_STRIPE_PRICE_MAX}
NUXT_STRIPE_PRICE_ULTRA=${NUXT_STRIPE_PRICE_ULTRA}
NUXT_STRIPE_AUTOMATIC_TAX=${NUXT_STRIPE_AUTOMATIC_TAX:-}

# ─── Transactional email (Resend) ───
# Empty RESEND_API_KEY = stub mode (emails logged, not sent). Set both
# for real delivery: the key + a verified-domain From address, e.g.
# markoto <no-reply@markoto.app> (no backticks here - heredoc context).
RESEND_API_KEY=${RESEND_API_KEY:-}
NUXT_EMAIL_FROM=${NUXT_EMAIL_FROM:-}

# ─── OAuth ───
NUXT_OAUTH_GITHUB_CLIENT_ID=${NUXT_OAUTH_GITHUB_CLIENT_ID:-}
NUXT_OAUTH_GITHUB_CLIENT_SECRET=${NUXT_OAUTH_GITHUB_CLIENT_SECRET:-}
NUXT_OAUTH_GOOGLE_CLIENT_ID=${NUXT_OAUTH_GOOGLE_CLIENT_ID:-}
NUXT_OAUTH_GOOGLE_CLIENT_SECRET=${NUXT_OAUTH_GOOGLE_CLIENT_SECRET:-}

# ─── Sentry ───
NUXT_PUBLIC_SENTRY_DSN=${NUXT_PUBLIC_SENTRY_DSN:-}
SENTRY_DSN=${SENTRY_DSN:-}

# ─── Traefik / ACME ───
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}

# ─── Image registry pin ───
REGISTRY=${REGISTRY}
IMAGE_TAG=${IMAGE_TAG}

# ─── Backup sidecar ───
BACKUP_INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS}
BACKUP_RETENTION_COUNT=${BACKUP_RETENTION_COUNT}
BACKUP_GPG_PASSPHRASE=${BACKUP_GPG_PASSPHRASE}

# ─── Postgres TLS ───
EOF

if [ -n "$OVH_PG_HOST" ] && [ -n "$OVH_PG_CA_REMOTE_PATH" ]; then
  echo "PGSSLROOTCERT=${OVH_PG_CA_REMOTE_PATH}"
  echo "PGSSL="
  # libpq-style sslmode consumed by litellm's DATABASE_URL, the
  # litellm-db-init psql, and the backup sidecar's pg_dump.
  echo "POSTGRES_SSLMODE=require"
else
  echo "PGSSLROOTCERT="
  echo "PGSSL=disable"
  echo "POSTGRES_SSLMODE=disable"
fi
