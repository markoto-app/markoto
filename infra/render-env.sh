#!/usr/bin/env bash
# Render /opt/markoto/.env from environment variables, for the CI-driven deploy
# (.github/workflows/deploy.yml). The workflow injects each value from GitHub
# Environment secrets/variables (provider keys included), whose NAMES
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
  NUXT_SESSION_PASSWORD NUXT_JWT_SECRET NUXT_INTERNAL_API_SECRET NUXT_ALTCHA_HMAC_KEY \
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

# Search-engine indexing (shared/config/instance.ts#resolveSiteIndexable).
# Default true; .github/workflows/deploy.yml passes false for every
# environment but prod, so staging answers robots.txt `Disallow: /` and
# `X-Robots-Tag: noindex` on every response.
NUXT_SITE_INDEXABLE="${NUXT_SITE_INDEXABLE:-true}"
case "$(echo "$NUXT_BILLING_ENABLED" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  1|true|yes|on)
    for v in \
      NUXT_STRIPE_SECRET_KEY NUXT_STRIPE_WEBHOOK_SECRET ; do
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

# Free AI allowance (docs/AI-MODELS.md#free-ai-allowance). Signed-in users
# without their own key get TIER_FREE_LITELLM_BUDGET_USD per month on the
# platform-paid chat default (Z.ai GLM-5.3 Flash served by Mistral on its
# EU endpoint, infra/litellm/config.yaml), all of them together capped at
# NUXT_FREE_TIER_TOTAL_BUDGET_USD per month (a LiteLLM team budget). An
# own key always takes precedence. Override any of these with an
# Environment variable; there is no transcription / image default (BYOK).
NUXT_AI_DEFAULT_CHAT_MODEL="${NUXT_AI_DEFAULT_CHAT_MODEL:-zai-glm-5-3-flash}"
NUXT_AI_DEFAULT_CHAT_VISION="${NUXT_AI_DEFAULT_CHAT_VISION:-true}"
TIER_FREE_LITELLM_BUDGET_USD="${TIER_FREE_LITELLM_BUDGET_USD:-0.5}"
NUXT_FREE_TIER_TOTAL_BUDGET_USD="${NUXT_FREE_TIER_TOTAL_BUDGET_USD:-500}"

# Hosted free-tier plan limits (shared/config/tiers.ts; the committed
# defaults are the self-host ones: every feature on, no limit). With
# billing off every account is on the free tier, so these are what
# everyone on markoto.app gets. Override with an Environment variable.
TIER_FREE_MEMBERS_PER_WORKSPACE="${TIER_FREE_MEMBERS_PER_WORKSPACE:-3}"
TIER_FREE_HISTORY_DAYS="${TIER_FREE_HISTORY_DAYS:-30}"
TIER_FREE_SAVED_THEMES="${TIER_FREE_SAVED_THEMES:-3}"
TIER_FREE_IMPORT_MAX_BYTES="${TIER_FREE_IMPORT_MAX_BYTES:-10485760}"
TIER_FREE_WEB_TOOLS_PER_DAY="${TIER_FREE_WEB_TOOLS_PER_DAY:-20}"
TIER_FREE_MCP_TOOL_CALLS_PER_DAY="${TIER_FREE_MCP_TOOL_CALLS_PER_DAY:-100}"
TIER_FREE_FEATURE_CUSTOM_CSS="${TIER_FREE_FEATURE_CUSTOM_CSS:-false}"
TIER_FREE_FEATURE_MCP_WRITE="${TIER_FREE_FEATURE_MCP_WRITE:-false}"

# Non-secret defaults (env.j2 sources these from group_vars/all.yml).
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
# Separate least-privilege Postgres roles (infra/postgres/db-init.sh). Empty =
# the app and LiteLLM keep using POSTGRES_USER (the compose files fall back);
# docs/LAUNCH-CHECKLIST.md has the switch-over.
POSTGRES_APP_USER="${POSTGRES_APP_USER:-}"
POSTGRES_APP_PASSWORD="${POSTGRES_APP_PASSWORD:-}"
POSTGRES_LITELLM_USER="${POSTGRES_LITELLM_USER:-}"
POSTGRES_LITELLM_PASSWORD="${POSTGRES_LITELLM_PASSWORD:-}"
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

# ─── Value safety ───
# Compose parses the rendered file, so an unquoted `$`, `#`, quote, backslash
# or backtick in a value would be interpolated, truncated or mangled, and a
# newline would inject extra keys. Values are therefore checked and, when they
# contain such characters, wrapped in single quotes (compose takes single-
# quoted values literally, like install.sh does). A single quote or a newline
# cannot be represented inside single quotes, so those fail the render.
# Plain values are emitted unchanged (byte-identical to infra/templates/env.j2).
VALKEY_TLS_ENABLED="$(echo "$VALKEY_TLS_ENABLED" | tr '[:upper:]' '[:lower:]')"
NUXT_AI_BYOK_ALLOW_PRIVATE_URLS="$(echo "$NUXT_AI_BYOK_ALLOW_PRIVATE_URLS" | tr '[:upper:]' '[:lower:]')"
NUXT_SITE_INDEXABLE="$(echo "$NUXT_SITE_INDEXABLE" | tr '[:upper:]' '[:lower:]')"

# DOMAIN is spliced into URLs (wss://sync.${DOMAIN}), so it must be a plain
# hostname rather than a quoted value.
case "$DOMAIN" in
  *[!A-Za-z0-9.-]*)
    echo "render-env: DOMAIN must be a plain hostname (letters, digits, '.', '-')" >&2
    exit 1
    ;;
esac

for n in \
  ACME_EMAIL BACKUP_GPG_PASSPHRASE BACKUP_INTERVAL_SECONDS \
  BACKUP_RETENTION_COUNT BACKUP_S3_ACCESS_KEY BACKUP_S3_BUCKET \
  BACKUP_S3_ENDPOINT BACKUP_S3_PREFIX BACKUP_S3_REGION \
  BACKUP_S3_SECRET_KEY BFL_API_KEY EMBEDDINGS_UPSTREAM_API_BASE \
  EMBEDDINGS_UPSTREAM_API_KEY EMBEDDINGS_UPSTREAM_MODEL IMAGE_TAG \
  JINA_AI_API_KEY LITELLM_MASTER_KEY LITELLM_SALT_KEY \
  MISTRAL_API_KEY NUXT_AI_BYOK_ALLOWED_BASE_URLS NUXT_AI_BYOK_ALLOW_PRIVATE_URLS \
  NUXT_AI_DEFAULT_CHAT_API_KEY NUXT_AI_DEFAULT_CHAT_BASE_URL NUXT_AI_DEFAULT_CHAT_MODEL \
  NUXT_AI_DEFAULT_CHAT_VISION NUXT_AI_DEFAULT_IMAGE_API_KEY NUXT_AI_DEFAULT_IMAGE_BASE_URL \
  NUXT_AI_DEFAULT_IMAGE_MODEL NUXT_AI_DEFAULT_TRANSCRIBE_API_KEY NUXT_AI_DEFAULT_TRANSCRIBE_BASE_URL \
  NUXT_AI_DEFAULT_TRANSCRIBE_MODEL NUXT_AI_DICTATE_JWT_SECRET NUXT_ALTCHA_HMAC_KEY NUXT_BILLING_ENABLED \
  NUXT_CANONICAL_SITE_URL NUXT_EMAIL_FROM NUXT_FREE_TIER_TOTAL_BUDGET_USD NUXT_IMAGE_GC_RETENTION_DAYS NUXT_INTERNAL_API_SECRET NUXT_INTERNAL_API_SECRET_PREVIOUS \
  NUXT_JWT_SECRET NUXT_JWT_SECRET_PREVIOUS NUXT_LITELLM_EMBEDDINGS_DIMS \
  NUXT_LITELLM_EMBEDDINGS_MODEL NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS NUXT_LITELLM_EMBEDDINGS_TASK_HINTS \
  NUXT_OAUTH_GITHUB_CLIENT_ID NUXT_OAUTH_GITHUB_CLIENT_SECRET NUXT_OAUTH_GOOGLE_CLIENT_ID \
  NUXT_OAUTH_GOOGLE_CLIENT_SECRET NUXT_PLANS_COMING_SOON NUXT_PUBLIC_SENTRY_DSN \
  NUXT_S3_ACCESS_KEY NUXT_S3_BUCKET NUXT_S3_ENDPOINT \
  NUXT_S3_SECRET_KEY NUXT_SESSION_PASSWORD NUXT_SITE_INDEXABLE NUXT_STRIPE_AUTOMATIC_TAX \
  NUXT_STRIPE_LOOKUP_KEY_PREFIX NUXT_STRIPE_PRICE_IDS \
  NUXT_STRIPE_SECRET_KEY NUXT_STRIPE_WEBHOOK_SECRET NUXT_WEB_TOOLS_DAILY_LIMIT \
  NUXT_WEB_TOOLS_HOURLY_LIMIT OVH_PG_CA_REMOTE_PATH POSTGRES_APP_PASSWORD \
  POSTGRES_APP_USER POSTGRES_DB POSTGRES_HOST \
  POSTGRES_LITELLM_PASSWORD POSTGRES_LITELLM_USER POSTGRES_PASSWORD \
  POSTGRES_PORT POSTGRES_USER REGISTRY RESEND_API_KEY \
  SENTRY_DSN STAAN_API_KEY TIER_FREE_IMAGE_BYTES_PER_USER TIER_FREE_KNOWLEDGE_BYTES_PER_USER \
  TIER_FREE_KNOWLEDGE_BYTES_PER_WORKSPACE TIER_FREE_KNOWLEDGE_FILES TIER_FREE_LITELLM_BUDGET_USD \
  TIER_FREE_WORKSPACES_OWNED TIER_FREE_MEMBERS_PER_WORKSPACE TIER_FREE_HISTORY_DAYS TIER_FREE_SAVED_THEMES \
  TIER_FREE_IMPORT_MAX_BYTES TIER_FREE_WEB_TOOLS_PER_DAY TIER_FREE_MCP_TOOL_CALLS_PER_DAY TIER_FREE_FEATURE_CUSTOM_CSS TIER_FREE_FEATURE_MCP_WRITE \
  VALKEY_DB VALKEY_PASSWORD \
  VALKEY_TLS_ENABLED
do
  v="${!n:-}"
  # A pasted secret often carries a trailing newline; drop it (warn) rather
  # than fail the deploy. Embedded newlines are rejected below.
  if [[ "$v" == *$'\n' || "$v" == *$'\r' ]]; then
    while [[ "$v" == *$'\n' || "$v" == *$'\r' ]]; do v="${v%?}"; done
    echo "render-env: warning: trailing newline stripped from '$n'" >&2
  fi
  case "$v" in
    *$'\n'*|*$'\r'*)
      echo "render-env: '$n' contains a newline, which cannot be written to a .env file" >&2
      exit 1
      ;;
    *\'*)
      echo "render-env: '$n' contains a single quote, which cannot be written to a .env file" >&2
      exit 1
      ;;
  esac
  if [[ "$v" == *[\$\#\"\\\`]* || "$v" =~ ^[[:space:]] || "$v" =~ [[:space:]]$ ]]; then
    v="'${v}'"
  fi
  printf -v "$n" '%s' "$v"
done

cat <<EOF
# markoto .env — rendered by CI (deploy.yml) from GitHub Environment secrets.
# Do not edit on the VPS; re-dispatch the deploy workflow after changing secrets.

# ─── App secrets ───
NUXT_SESSION_PASSWORD=${NUXT_SESSION_PASSWORD}
NUXT_JWT_SECRET=${NUXT_JWT_SECRET}
NUXT_INTERNAL_API_SECRET=${NUXT_INTERNAL_API_SECRET}
NUXT_JWT_SECRET_PREVIOUS=${NUXT_JWT_SECRET_PREVIOUS:-}
NUXT_INTERNAL_API_SECRET_PREVIOUS=${NUXT_INTERNAL_API_SECRET_PREVIOUS:-}
# Anonymous gate: HMAC key of the self-hosted ALTCHA bot check + the
# remembered-terms cookie (server/utils/anonGate/).
NUXT_ALTCHA_HMAC_KEY=${NUXT_ALTCHA_HMAC_KEY}

# ─── Postgres ───
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_HOST=${POSTGRES_HOST}
POSTGRES_PORT=${POSTGRES_PORT}
POSTGRES_APP_USER=${POSTGRES_APP_USER}
POSTGRES_APP_PASSWORD=${POSTGRES_APP_PASSWORD}
POSTGRES_LITELLM_USER=${POSTGRES_LITELLM_USER}
POSTGRES_LITELLM_PASSWORD=${POSTGRES_LITELLM_PASSWORD}

# ─── Valkey ───
VALKEY_HOST=valkey
VALKEY_PORT=6379
VALKEY_PASSWORD=${VALKEY_PASSWORD}
VALKEY_DB=${VALKEY_DB}
VALKEY_TLS_ENABLED=${VALKEY_TLS_ENABLED}

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

# ─── Bring-your-own-key AI (WP4) + free AI allowance ───
# Instance defaults per capability. Hosted: chat = the free-allowance
# alias (platform-paid, capped per user + in total), image / transcription
# empty (BYOK only). MODEL alone = a LiteLLM model alias (platform-paid);
# MODEL + BASE_URL + API_KEY = an OpenAI-compatible endpoint used like a
# user key.
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
NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=${NUXT_AI_BYOK_ALLOW_PRIVATE_URLS}
# Global monthly ceiling (USD) on platform-paid AI for all free-tier users.
NUXT_FREE_TIER_TOTAL_BUDGET_USD=${NUXT_FREE_TIER_TOTAL_BUDGET_USD}

# ─── Billing mode ───
NUXT_BILLING_ENABLED=${NUXT_BILLING_ENABLED}
NUXT_PLANS_COMING_SOON=${NUXT_PLANS_COMING_SOON}

# ─── Legal surfaces (hosted: onboarding gate, consent, DPA, /legal/*) ───
NUXT_LEGAL_SURFACES_ENABLED=true
# Anonymous gate (terms + bot check before anonymous docs / reports). Follows
# the legal surfaces; pinned on for the hosted service.
NUXT_ANON_GATE_ENABLED=true

# ─── Marketing site (hosted: product tour at /, sitemap, JSON-LD, marketing pages) ───
# Replaces NUXT_PRODUCT_TOUR_ENABLED (still read as an alias for one release).
NUXT_MARKETING_SITE_ENABLED=true
# Search-engine indexing: false on staging (robots.txt Disallow: / + noindex).
NUXT_SITE_INDEXABLE=${NUXT_SITE_INDEXABLE}
# Origin for canonical / og:url / JSON-LD / sitemap; empty = NUXT_SITE_URL.
# Staging: https://markoto.app, so its copy never competes with the real site.
NUXT_CANONICAL_SITE_URL=${NUXT_CANONICAL_SITE_URL:-}

# ─── Stripe billing (only read when NUXT_BILLING_ENABLED is true) ───
NUXT_STRIPE_SECRET_KEY=${NUXT_STRIPE_SECRET_KEY:-}
NUXT_STRIPE_WEBHOOK_SECRET=${NUXT_STRIPE_WEBHOOK_SECRET:-}
NUXT_STRIPE_LOOKUP_KEY_PREFIX=${NUXT_STRIPE_LOOKUP_KEY_PREFIX:-}
NUXT_STRIPE_PRICE_IDS=${NUXT_STRIPE_PRICE_IDS:-}
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
TIER_FREE_MEMBERS_PER_WORKSPACE=${TIER_FREE_MEMBERS_PER_WORKSPACE:-}
TIER_FREE_HISTORY_DAYS=${TIER_FREE_HISTORY_DAYS:-}
TIER_FREE_SAVED_THEMES=${TIER_FREE_SAVED_THEMES:-}
TIER_FREE_IMPORT_MAX_BYTES=${TIER_FREE_IMPORT_MAX_BYTES:-}
TIER_FREE_WEB_TOOLS_PER_DAY=${TIER_FREE_WEB_TOOLS_PER_DAY:-}
TIER_FREE_MCP_TOOL_CALLS_PER_DAY=${TIER_FREE_MCP_TOOL_CALLS_PER_DAY:-}
TIER_FREE_FEATURE_CUSTOM_CSS=${TIER_FREE_FEATURE_CUSTOM_CSS:-}
TIER_FREE_FEATURE_MCP_WRITE=${TIER_FREE_FEATURE_MCP_WRITE:-}
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
  # db-init psql, and the backup sidecar's pg_dump.
  echo "POSTGRES_SSLMODE=require"
else
  echo "PGSSLROOTCERT="
  echo "PGSSL=disable"
  echo "POSTGRES_SSLMODE=disable"
fi
