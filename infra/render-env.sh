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
  BACKUP_GPG_PASSPHRASE \
  DOMAIN ACME_EMAIL REGISTRY IMAGE_TAG ; do
  require "$v"
done

# Billing mode (shared/config/billingMode.ts). The hosted deployment runs
# free-only with paid plans advertised as "coming soon": billing OFF,
# coming-soon ON. Stripe secrets are only required once billing is on —
# the same truthy spellings the app accepts (1/true/yes/on).
NUXT_BILLING_ENABLED="${NUXT_BILLING_ENABLED:-false}"
NUXT_PLANS_COMING_SOON="${NUXT_PLANS_COMING_SOON:-true}"
case "$(echo "$NUXT_BILLING_ENABLED" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  1|true|yes|on)
    for v in \
      NUXT_STRIPE_SECRET_KEY NUXT_STRIPE_WEBHOOK_SECRET \
      NUXT_STRIPE_PRICE_PRO NUXT_STRIPE_PRICE_MAX NUXT_STRIPE_PRICE_ULTRA ; do
      require "$v"
    done
    ;;
esac

# Bring-your-own-key AI (WP4). The hosted SaaS sets NO instance AI defaults
# (every user brings their own key) and restricts BYOK base URLs to the
# provider allowlist below (shared/ai/providers.ts
# RECOMMENDED_SAAS_ALLOWED_BASE_URLS — keep in sync). Private-network
# provider URLs stay off.
NUXT_AI_BYOK_ALLOWED_BASE_URLS="${NUXT_AI_BYOK_ALLOWED_BASE_URLS:-https://api.mistral.ai/v1,https://api.openai.com/v1,https://openrouter.ai/api/v1,https://api.groq.com/openai/v1,https://api.together.xyz/v1,https://api.deepinfra.com/v1/openai,https://api.fireworks.ai/inference/v1,https://api.scaleway.ai/v1}"
NUXT_AI_BYOK_ALLOW_PRIVATE_URLS="${NUXT_AI_BYOK_ALLOW_PRIVATE_URLS:-false}"

# Non-secret defaults (env.j2 sources these from group_vars/all.yml).
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
VALKEY_DB="${VALKEY_DB:-0}"
VALKEY_TLS_ENABLED="${VALKEY_TLS_ENABLED:-false}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-30}"
# Backup storage: only the backup sidecar receives these. Each falls back to
# the app's NUXT_S3_* value (or the stock region/prefix) until a dedicated
# backup bucket is provisioned (docs/LAUNCH-CHECKLIST.md).
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-$NUXT_S3_ENDPOINT}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-$NUXT_S3_BUCKET}"
BACKUP_S3_ACCESS_KEY="${BACKUP_S3_ACCESS_KEY:-$NUXT_S3_ACCESS_KEY}"
BACKUP_S3_SECRET_KEY="${BACKUP_S3_SECRET_KEY:-$NUXT_S3_SECRET_KEY}"
BACKUP_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-backups/postgres}"
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

# ─── Web-tool allowance (calls/user; empty = default 30/hour, 100/day; 0 = unlimited) ───
NUXT_WEB_TOOLS_HOURLY_LIMIT=${NUXT_WEB_TOOLS_HOURLY_LIMIT:-}
NUXT_WEB_TOOLS_DAILY_LIMIT=${NUXT_WEB_TOOLS_DAILY_LIMIT:-}

# ─── Knowledge-base embeddings (self-hosting; empty = hosted defaults) ───
# Compose falls back to Jina v5-text-nano @ 768 for every empty value.
# docs/AI-MODELS.md#embeddings
NUXT_LITELLM_EMBEDDINGS_MODEL=${NUXT_LITELLM_EMBEDDINGS_MODEL:-}
NUXT_LITELLM_EMBEDDINGS_DIMS=${NUXT_LITELLM_EMBEDDINGS_DIMS:-}
NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS=${NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS:-}
NUXT_LITELLM_EMBEDDINGS_TASK_HINTS=${NUXT_LITELLM_EMBEDDINGS_TASK_HINTS:-}
EMBEDDINGS_UPSTREAM_MODEL=${EMBEDDINGS_UPSTREAM_MODEL:-}
EMBEDDINGS_UPSTREAM_API_BASE=${EMBEDDINGS_UPSTREAM_API_BASE:-}
EMBEDDINGS_UPSTREAM_API_KEY=${EMBEDDINGS_UPSTREAM_API_KEY:-}

# ─── Bring-your-own-key AI (WP4) ───
# Instance defaults per capability (empty on the hosted SaaS = BYOK only).
# MODEL alone = a LiteLLM model alias (platform-paid); MODEL + BASE_URL +
# API_KEY = an OpenAI-compatible endpoint used like a user key.
NUXT_AI_DEFAULT_CHAT_MODEL=${NUXT_AI_DEFAULT_CHAT_MODEL:-}
NUXT_AI_DEFAULT_CHAT_BASE_URL=${NUXT_AI_DEFAULT_CHAT_BASE_URL:-}
NUXT_AI_DEFAULT_CHAT_API_KEY=${NUXT_AI_DEFAULT_CHAT_API_KEY:-}
NUXT_AI_DEFAULT_CHAT_VISION=${NUXT_AI_DEFAULT_CHAT_VISION:-}
NUXT_AI_DEFAULT_IMAGE_MODEL=${NUXT_AI_DEFAULT_IMAGE_MODEL:-}
NUXT_AI_DEFAULT_IMAGE_BASE_URL=${NUXT_AI_DEFAULT_IMAGE_BASE_URL:-}
NUXT_AI_DEFAULT_IMAGE_API_KEY=${NUXT_AI_DEFAULT_IMAGE_API_KEY:-}
NUXT_AI_DEFAULT_TRANSCRIBE_MODEL=${NUXT_AI_DEFAULT_TRANSCRIBE_MODEL:-}
NUXT_AI_DEFAULT_TRANSCRIBE_BASE_URL=${NUXT_AI_DEFAULT_TRANSCRIBE_BASE_URL:-}
NUXT_AI_DEFAULT_TRANSCRIBE_API_KEY=${NUXT_AI_DEFAULT_TRANSCRIBE_API_KEY:-}
NUXT_AI_BYOK_ALLOWED_BASE_URLS=${NUXT_AI_BYOK_ALLOWED_BASE_URLS}
NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=$(echo "$NUXT_AI_BYOK_ALLOW_PRIVATE_URLS" | tr '[:upper:]' '[:lower:]')

# ─── Billing mode ───
NUXT_BILLING_ENABLED=${NUXT_BILLING_ENABLED}
NUXT_PLANS_COMING_SOON=${NUXT_PLANS_COMING_SOON}

# ─── Legal surfaces (hosted: onboarding gate, consent, DPA, /legal/*) ───
NUXT_LEGAL_SURFACES_ENABLED=true

# ─── Stripe billing (only read when NUXT_BILLING_ENABLED is true) ───
NUXT_STRIPE_SECRET_KEY=${NUXT_STRIPE_SECRET_KEY:-}
NUXT_STRIPE_WEBHOOK_SECRET=${NUXT_STRIPE_WEBHOOK_SECRET:-}
NUXT_STRIPE_PRICE_PRO=${NUXT_STRIPE_PRICE_PRO:-}
NUXT_STRIPE_PRICE_MAX=${NUXT_STRIPE_PRICE_MAX:-}
NUXT_STRIPE_PRICE_ULTRA=${NUXT_STRIPE_PRICE_ULTRA:-}
NUXT_STRIPE_AUTOMATIC_TAX=${NUXT_STRIPE_AUTOMATIC_TAX:-}

# ─── Free-tier limit overrides (optional; empty = committed default) ───
# With billing off every account is on the free tier, so these are the
# hosted deployment's effective limits. See shared/config/tiers.ts.
TIER_FREE_LITELLM_BUDGET_USD=${TIER_FREE_LITELLM_BUDGET_USD:-}
TIER_FREE_WORKSPACES_OWNED=${TIER_FREE_WORKSPACES_OWNED:-}
TIER_FREE_KNOWLEDGE_FILES=${TIER_FREE_KNOWLEDGE_FILES:-}
TIER_FREE_KNOWLEDGE_BYTES_PER_WORKSPACE=${TIER_FREE_KNOWLEDGE_BYTES_PER_WORKSPACE:-}
TIER_FREE_KNOWLEDGE_BYTES_PER_USER=${TIER_FREE_KNOWLEDGE_BYTES_PER_USER:-}
TIER_FREE_IMAGE_BYTES_PER_USER=${TIER_FREE_IMAGE_BYTES_PER_USER:-}
# Days an unreferenced doc image is kept before the image GC deletes it (0 = off).
NUXT_IMAGE_GC_RETENTION_DAYS=${NUXT_IMAGE_GC_RETENTION_DAYS:-}

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
BACKUP_S3_ENDPOINT=${BACKUP_S3_ENDPOINT}
BACKUP_S3_BUCKET=${BACKUP_S3_BUCKET}
BACKUP_S3_ACCESS_KEY=${BACKUP_S3_ACCESS_KEY}
BACKUP_S3_SECRET_KEY=${BACKUP_S3_SECRET_KEY}
BACKUP_S3_REGION=${BACKUP_S3_REGION}
BACKUP_S3_PREFIX=${BACKUP_S3_PREFIX}

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
