#!/usr/bin/env bash
# Render the hosted stack's .env (/opt/markoto/.env) from environment
# variables whose names are the .env keys. Both deploy paths use it:
#   - .github/workflows/deploy.yml injects GitHub Environment secrets and
#     variables;
#   - the Ansible role (infra/roles/markoto) passes group_vars + vault, each
#     key read from the Ansible variable of the same name in lower case
#     (`bash infra/render-env.sh --keys` lists them).
# One renderer, so the two paths cannot drift.
#
# Required vars fail loud (empty -> exit 1) so a broken render can never write a
# half-empty .env that the app then boots against. infra/render-env-test.sh
# pins the behaviour.
set -euo pipefail

# Every input this script reads. `--keys` prints them (the Ansible role
# builds its environment from this list); each is value-checked below.
INPUTS=(
  ACME_EMAIL BACKUP_GPG_PASSPHRASE BACKUP_INTERVAL_SECONDS
  BACKUP_RETENTION_COUNT BACKUP_S3_ACCESS_KEY BACKUP_S3_BUCKET
  BACKUP_S3_ENDPOINT BACKUP_S3_PREFIX BACKUP_S3_REGION BACKUP_S3_SECRET_KEY
  BFL_API_KEY COMPACT_INTERVAL_MS COMPACT_MAX_DOCS_PER_RUN
  COMPACT_RETAIN_HISTORY_DAYS COMPACT_THRESHOLD DOMAIN
  EMBEDDINGS_UPSTREAM_API_BASE EMBEDDINGS_UPSTREAM_API_KEY
  EMBEDDINGS_UPSTREAM_MODEL IMAGE_TAG JINA_AI_API_KEY LITELLM_MASTER_KEY
  LITELLM_SALT_KEY MISTRAL_API_KEY NUXT_ABUSE_REPORT_RETENTION_DAYS
  NUXT_ADMIN_USER_EMAILS NUXT_AI_BYOK_ALLOWED_BASE_URLS
  NUXT_AI_BYOK_ALLOW_PRIVATE_URLS NUXT_AI_DEFAULT_CHAT_API_KEY
  NUXT_AI_DEFAULT_CHAT_BASE_URL NUXT_AI_DEFAULT_CHAT_MODEL
  NUXT_AI_DEFAULT_CHAT_STRONG_MODEL NUXT_AI_DEFAULT_CHAT_VISION
  NUXT_AI_DEFAULT_IMAGE_API_KEY NUXT_AI_DEFAULT_IMAGE_BASE_URL
  NUXT_AI_DEFAULT_IMAGE_MODEL NUXT_AI_DEFAULT_TRANSCRIBE_API_KEY
  NUXT_AI_DEFAULT_TRANSCRIBE_BASE_URL NUXT_AI_DEFAULT_TRANSCRIBE_MODEL
  NUXT_AI_DICTATE_JWT_SECRET NUXT_AI_REALTIME_MODEL NUXT_ALTCHA_HMAC_KEY
  NUXT_AUDIT_LOG_RETENTION_DAYS NUXT_BILLING_ENABLED NUXT_CANONICAL_SITE_URL
  NUXT_EMAIL_FROM NUXT_EMAIL_PROVIDER NUXT_ENCRYPTION_KEY
  NUXT_ENCRYPTION_KEY_PREVIOUS NUXT_FREE_TIER_TOTAL_BUDGET_USD
  NUXT_IMAGE_GC_RETENTION_DAYS NUXT_INACTIVE_DOC_TTL_DAYS
  NUXT_INTERNAL_API_SECRET NUXT_INTERNAL_API_SECRET_PREVIOUS NUXT_JWT_SECRET
  NUXT_JWT_SECRET_PREVIOUS NUXT_LEGAL_ABUSE_CONTACT_EMAIL NUXT_LEGAL_CH_ID
  NUXT_LEGAL_CONTROLLER_ADDRESS NUXT_LEGAL_CONTROLLER_NAME NUXT_LEGAL_EHRA_ID
  NUXT_LEGAL_GOVERNING_LAW NUXT_LEGAL_LEGAL_FORM
  NUXT_LEGAL_PRIVACY_CONTACT_EMAIL NUXT_LEGAL_REGISTERED_OFFICE
  NUXT_LEGAL_REPRESENTED_BY NUXT_LEGAL_UID NUXT_LITELLM_EMBEDDINGS_DIMS
  NUXT_LITELLM_EMBEDDINGS_MODEL NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS
  NUXT_LITELLM_EMBEDDINGS_TASK_HINTS NUXT_MARKITDOWN_API_SECRET
  NUXT_OAUTH_GITHUB_CLIENT_ID NUXT_OAUTH_GITHUB_CLIENT_SECRET
  NUXT_OAUTH_GOOGLE_CLIENT_ID NUXT_OAUTH_GOOGLE_CLIENT_SECRET
  NUXT_PLANS_COMING_SOON NUXT_PUBLIC_SENTRY_DSN NUXT_PUBLISH_DOMAINS_TARGET
  NUXT_PUBLISH_PAGES_HOST NUXT_PUBLISH_TRAEFIK_TOKEN NUXT_S3_ACCESS_KEY
  NUXT_S3_BUCKET NUXT_S3_ENDPOINT NUXT_S3_SECRET_KEY NUXT_SESSION_PASSWORD
  NUXT_SITE_INDEXABLE NUXT_STRIPE_AUTOMATIC_TAX NUXT_STRIPE_LOOKUP_KEY_PREFIX
  NUXT_STRIPE_PRICE_IDS NUXT_STRIPE_SECRET_KEY NUXT_STRIPE_WEBHOOK_SECRET
  NUXT_TRUSTED_PROXY_HOPS NUXT_WEB_TOOLS_DAILY_LIMIT
  NUXT_WEB_TOOLS_HOURLY_LIMIT OVH_PG_CA_REMOTE_PATH OVH_PG_HOST
  POSTGRES_APP_PASSWORD POSTGRES_APP_USER POSTGRES_DB POSTGRES_HOST
  POSTGRES_LITELLM_PASSWORD POSTGRES_LITELLM_USER POSTGRES_PASSWORD
  POSTGRES_PORT POSTGRES_USER REGISTRY RENDERER_ALLOWED_ORIGINS
  RESEND_API_KEY SENTRY_DSN STAAN_API_KEY SYNC_AUTH_TIMEOUT_MS
  SYNC_MAX_CONNECTIONS_PER_IP SYNC_MAX_DOCUMENT_BYTES SYNC_MAX_MESSAGE_BYTES
  SYNC_MAX_PREAUTH_BYTES SYNC_MAX_PREAUTH_TOTAL_BYTES SYNC_MAX_UPDATE_BYTES
  TIER_FREE_FEATURE_AI_IMAGE TIER_FREE_FEATURE_AI_STRONG_MODEL
  TIER_FREE_FEATURE_AI_VOICE TIER_FREE_FEATURE_AUDIT_LOG
  TIER_FREE_FEATURE_BRAND_KIT TIER_FREE_FEATURE_CUSTOM_CSS
  TIER_FREE_FEATURE_CUSTOM_DOMAINS TIER_FREE_FEATURE_GUESTS
  TIER_FREE_FEATURE_MCP_WRITE TIER_FREE_FEATURE_SHARE_CONTROLS
  TIER_FREE_FEATURE_SSO TIER_FREE_HISTORY_DAYS TIER_FREE_IMAGE_BYTES_PER_USER
  TIER_FREE_IMPORT_MAX_BYTES TIER_FREE_KNOWLEDGE_BYTES_PER_USER
  TIER_FREE_KNOWLEDGE_BYTES_PER_WORKSPACE TIER_FREE_KNOWLEDGE_FILES
  TIER_FREE_LITELLM_BUDGET_USD TIER_FREE_MCP_TOOL_CALLS_PER_DAY
  TIER_FREE_MEMBERS_PER_WORKSPACE TIER_FREE_SAVED_THEMES
  TIER_FREE_WEB_TOOLS_PER_DAY TIER_FREE_WORKSPACES_OWNED
  TIER_PRO_FEATURE_AUDIT_LOG TIER_PRO_FEATURE_BRAND_KIT
  TIER_PRO_FEATURE_GUESTS TIER_PRO_FEATURE_SSO TIER_TEAM_FEATURE_AUDIT_LOG
  TIER_TEAM_FEATURE_SSO VALKEY_DB VALKEY_PASSWORD
)
if [ "${1:-}" = --keys ]; then
  printf '%s\n' "${INPUTS[@]}"
  exit 0
fi

require() {  # require VAR_NAME
  local n="$1"
  if [ -z "${!n:-}" ]; then
    echo "render-env: required var '$n' is empty" >&2
    exit 1
  fi
}
for v in \
  NUXT_SESSION_PASSWORD NUXT_JWT_SECRET NUXT_INTERNAL_API_SECRET NUXT_ALTCHA_HMAC_KEY \
  NUXT_MARKITDOWN_API_SECRET NUXT_ENCRYPTION_KEY \
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
  VALKEY_PASSWORD \
  NUXT_S3_ENDPOINT NUXT_S3_ACCESS_KEY NUXT_S3_SECRET_KEY NUXT_S3_BUCKET \
  LITELLM_MASTER_KEY LITELLM_SALT_KEY \
  JINA_AI_API_KEY STAAN_API_KEY MISTRAL_API_KEY BFL_API_KEY \
  BACKUP_GPG_PASSPHRASE \
  DOMAIN ACME_EMAIL REGISTRY IMAGE_TAG ; do
  require "$v"
done

# The rendered stack always runs with the legal surfaces on, and the app
# refuses to boot without these two (shared/legal/entity.ts). Failing here
# stops the deploy before the running stack is touched, instead of after
# the new containers crash-loop into the auto-rollback.
for v in NUXT_LEGAL_CONTROLLER_ADDRESS NUXT_LEGAL_REPRESENTED_BY; do
  if [ -z "${!v:-}" ]; then
    echo "render-env: '$v' is empty: the legal pages need it (set it as a GitHub Environment variable)" >&2
    exit 1
  fi
done

# Published pages are served from their own hostname (the app refuses to
# boot in the hosted shape without it, and prod compose routes it with its
# own certificate). It is spliced into a Traefik rule, so: plain hostname.
if [ -z "${NUXT_PUBLISH_PAGES_HOST:-}" ]; then
  echo "render-env: 'NUXT_PUBLISH_PAGES_HOST' is empty: published pages need their own hostname, e.g. pages.\${DOMAIN} (set it as a GitHub Environment variable and add its DNS record)" >&2
  exit 1
fi
case "$NUXT_PUBLISH_PAGES_HOST" in
  *[!A-Za-z0-9.-]*)
    echo "render-env: NUXT_PUBLISH_PAGES_HOST must be a plain hostname (letters, digits, '.', '-')" >&2
    exit 1
    ;;
esac

# Billing mode (shared/config/billingMode.ts). The hosted deployment runs
# free-only with paid plans advertised as "coming soon": billing OFF,
# coming-soon ON. Stripe secrets are only required once billing is on,
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

# Bring-your-own-key AI. The hosted SaaS restricts BYOK base URLs to the
# provider allowlist below (shared/ai/providers.ts
# RECOMMENDED_SAAS_ALLOWED_BASE_URLS: keep in sync). Private-network
# provider URLs stay off.
NUXT_AI_BYOK_ALLOWED_BASE_URLS="${NUXT_AI_BYOK_ALLOWED_BASE_URLS:-https://api.mistral.ai/v1,https://api.openai.com/v1,https://openrouter.ai/api/v1,https://api.groq.com/openai/v1,https://api.together.xyz/v1,https://api.deepinfra.com/v1/openai,https://api.fireworks.ai/inference/v1,https://api.scaleway.ai/v1}"
NUXT_AI_BYOK_ALLOW_PRIVATE_URLS="${NUXT_AI_BYOK_ALLOW_PRIVATE_URLS:-false}"

# Free AI allowance (docs/AI-MODELS.md#free-ai-allowance). Signed-in users
# without their own key get TIER_FREE_LITELLM_BUDGET_USD per month on the
# platform-paid chat default (Z.ai GLM-5.3 Flash served by Mistral on its
# EU endpoint, deploy/config/litellm/config.yaml), all of them together capped at
# NUXT_FREE_TIER_TOTAL_BUDGET_USD per month (a LiteLLM team budget). An
# own key always takes precedence. Override any of these with an
# Environment variable. The strong chat model, image generation and voice
# are platform-paid too, but only for plans that include them
# (TIER_<PLAN>_FEATURE_AI_*; the free tier below has them off, so with
# billing off nobody on markoto.app gets them without their own key).
NUXT_AI_DEFAULT_CHAT_MODEL="${NUXT_AI_DEFAULT_CHAT_MODEL:-zai-glm-5-3-flash}"
NUXT_AI_DEFAULT_CHAT_VISION="${NUXT_AI_DEFAULT_CHAT_VISION:-true}"
NUXT_AI_DEFAULT_CHAT_STRONG_MODEL="${NUXT_AI_DEFAULT_CHAT_STRONG_MODEL:-mistral-small-2603}"
NUXT_AI_DEFAULT_IMAGE_MODEL="${NUXT_AI_DEFAULT_IMAGE_MODEL:-flux-2-pro}"
NUXT_AI_DEFAULT_TRANSCRIBE_MODEL="${NUXT_AI_DEFAULT_TRANSCRIBE_MODEL:-voxtral-mini-transcribe}"
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
TIER_FREE_FEATURE_AI_IMAGE="${TIER_FREE_FEATURE_AI_IMAGE:-false}"
TIER_FREE_FEATURE_AI_VOICE="${TIER_FREE_FEATURE_AI_VOICE:-false}"
TIER_FREE_FEATURE_AI_STRONG_MODEL="${TIER_FREE_FEATURE_AI_STRONG_MODEL:-false}"
TIER_FREE_FEATURE_SSO="${TIER_FREE_FEATURE_SSO:-false}"
TIER_FREE_FEATURE_AUDIT_LOG="${TIER_FREE_FEATURE_AUDIT_LOG:-false}"
TIER_FREE_FEATURE_GUESTS="${TIER_FREE_FEATURE_GUESTS:-false}"
TIER_FREE_FEATURE_BRAND_KIT="${TIER_FREE_FEATURE_BRAND_KIT:-false}"
TIER_FREE_FEATURE_SHARE_CONTROLS="${TIER_FREE_FEATURE_SHARE_CONTROLS:-false}"
TIER_FREE_FEATURE_CUSTOM_DOMAINS="${TIER_FREE_FEATURE_CUSTOM_DOMAINS:-false}"
# Single sign-on is a Business feature on markoto.app.
TIER_PRO_FEATURE_SSO="${TIER_PRO_FEATURE_SSO:-false}"
TIER_PRO_FEATURE_AUDIT_LOG="${TIER_PRO_FEATURE_AUDIT_LOG:-false}"
TIER_PRO_FEATURE_GUESTS="${TIER_PRO_FEATURE_GUESTS:-false}"
TIER_PRO_FEATURE_BRAND_KIT="${TIER_PRO_FEATURE_BRAND_KIT:-false}"
TIER_TEAM_FEATURE_SSO="${TIER_TEAM_FEATURE_SSO:-false}"
TIER_TEAM_FEATURE_AUDIT_LOG="${TIER_TEAM_FEATURE_AUDIT_LOG:-false}"

# Non-secret defaults (the Ansible path passes group_vars/all.yml values).
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
# Separate least-privilege Postgres roles (deploy/config/postgres/db-init.sh). Empty =
# the app and LiteLLM keep using POSTGRES_USER (the compose files fall back);
# the switch-over is in the operator runbook, kept outside this repository.
POSTGRES_APP_USER="${POSTGRES_APP_USER:-}"
POSTGRES_APP_PASSWORD="${POSTGRES_APP_PASSWORD:-}"
POSTGRES_LITELLM_USER="${POSTGRES_LITELLM_USER:-}"
POSTGRES_LITELLM_PASSWORD="${POSTGRES_LITELLM_PASSWORD:-}"
VALKEY_DB="${VALKEY_DB:-0}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-30}"
# Backup storage: only the backup sidecar receives these. Each falls back to
# the app's NUXT_S3_* value (or the stock region/prefix) until a dedicated
# backup bucket is provisioned.
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
# Plain values are emitted unchanged.
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

for n in "${INPUTS[@]}"; do
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
# markoto .env: rendered by infra/render-env.sh (deploy.yml or Ansible).
# Do not edit on the VPS; re-deploy after changing the secrets or group_vars.

# Compose reads this file from the working directory (/opt/markoto) and
# takes the stack from here, so every command on the host is a plain
# \`docker compose <command>\` run there.
COMPOSE_FILE=deploy/compose/compose.prod.yml

# ─── App secrets ───
NUXT_SESSION_PASSWORD=${NUXT_SESSION_PASSWORD}
NUXT_JWT_SECRET=${NUXT_JWT_SECRET}
NUXT_INTERNAL_API_SECRET=${NUXT_INTERNAL_API_SECRET}
NUXT_JWT_SECRET_PREVIOUS=${NUXT_JWT_SECRET_PREVIOUS:-}
NUXT_INTERNAL_API_SECRET_PREVIOUS=${NUXT_INTERNAL_API_SECRET_PREVIOUS:-}
# Encrypts the secrets the app stores in Postgres. Losing it makes stored
# provider keys and SSO secrets unreadable; rotate via _PREVIOUS.
NUXT_ENCRYPTION_KEY=${NUXT_ENCRYPTION_KEY}
NUXT_ENCRYPTION_KEY_PREVIOUS=${NUXT_ENCRYPTION_KEY_PREVIOUS:-}
# Anonymous gate: HMAC key of the self-hosted ALTCHA bot check + the
# remembered-terms cookie (server/utils/anonGate/).
NUXT_ALTCHA_HMAC_KEY=${NUXT_ALTCHA_HMAC_KEY}
# Shared secret between the app and the markitdown converter (its own, so a
# compromised converter cannot call sync or /api/internal).
NUXT_MARKITDOWN_API_SECRET=${NUXT_MARKITDOWN_API_SECRET}
# Custom domains of published pages: the host customers CNAME to
# (empty = off) and the token Traefik's HTTP provider sends (>= 32 chars).
NUXT_PUBLISH_DOMAINS_TARGET=${NUXT_PUBLISH_DOMAINS_TARGET:-}
NUXT_PUBLISH_TRAEFIK_TOKEN=${NUXT_PUBLISH_TRAEFIK_TOKEN:-}
# Published pages' own hostname (e.g. pages.markoto.app). Required by the
# hosted shape's boot check; needs the token above (Traefik routes it).
NUXT_PUBLISH_PAGES_HOST=${NUXT_PUBLISH_PAGES_HOST:-}

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
VALKEY_PASSWORD=${VALKEY_PASSWORD}
VALKEY_DB=${VALKEY_DB}

# ─── S3 / object storage ───
NUXT_S3_ENDPOINT=${NUXT_S3_ENDPOINT}
NUXT_S3_ACCESS_KEY=${NUXT_S3_ACCESS_KEY}
NUXT_S3_SECRET_KEY=${NUXT_S3_SECRET_KEY}
NUXT_S3_BUCKET=${NUXT_S3_BUCKET}

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

# ─── Bring-your-own-key AI + free AI allowance ───
# Instance defaults per capability. Hosted: chat = the free-allowance
# alias (platform-paid, capped per user + in total), image / transcription
# empty (BYOK only). MODEL alone = a LiteLLM model alias (platform-paid);
# MODEL + BASE_URL + API_KEY = an OpenAI-compatible endpoint used like a
# user key.
NUXT_AI_DEFAULT_CHAT_MODEL=${NUXT_AI_DEFAULT_CHAT_MODEL:-}
NUXT_AI_DEFAULT_CHAT_BASE_URL=${NUXT_AI_DEFAULT_CHAT_BASE_URL:-}
NUXT_AI_DEFAULT_CHAT_API_KEY=${NUXT_AI_DEFAULT_CHAT_API_KEY:-}
NUXT_AI_DEFAULT_CHAT_VISION=${NUXT_AI_DEFAULT_CHAT_VISION:-}
NUXT_AI_DEFAULT_CHAT_STRONG_MODEL=${NUXT_AI_DEFAULT_CHAT_STRONG_MODEL:-}
NUXT_AI_DEFAULT_IMAGE_MODEL=${NUXT_AI_DEFAULT_IMAGE_MODEL:-}
NUXT_AI_DEFAULT_IMAGE_BASE_URL=${NUXT_AI_DEFAULT_IMAGE_BASE_URL:-}
NUXT_AI_DEFAULT_IMAGE_API_KEY=${NUXT_AI_DEFAULT_IMAGE_API_KEY:-}
NUXT_AI_DEFAULT_TRANSCRIBE_MODEL=${NUXT_AI_DEFAULT_TRANSCRIBE_MODEL:-}
NUXT_AI_DEFAULT_TRANSCRIBE_BASE_URL=${NUXT_AI_DEFAULT_TRANSCRIBE_BASE_URL:-}
NUXT_AI_DEFAULT_TRANSCRIBE_API_KEY=${NUXT_AI_DEFAULT_TRANSCRIBE_API_KEY:-}
NUXT_AI_REALTIME_MODEL=${NUXT_AI_REALTIME_MODEL:-}
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
# Operator identity on the legal pages (shared/legal/entity.ts). Empty = the
# code default; CONTROLLER_ADDRESS and REPRESENTED_BY have none.
NUXT_LEGAL_CONTROLLER_NAME=${NUXT_LEGAL_CONTROLLER_NAME:-}
NUXT_LEGAL_CONTROLLER_ADDRESS=${NUXT_LEGAL_CONTROLLER_ADDRESS}
NUXT_LEGAL_PRIVACY_CONTACT_EMAIL=${NUXT_LEGAL_PRIVACY_CONTACT_EMAIL:-}
NUXT_LEGAL_ABUSE_CONTACT_EMAIL=${NUXT_LEGAL_ABUSE_CONTACT_EMAIL:-}
NUXT_LEGAL_GOVERNING_LAW=${NUXT_LEGAL_GOVERNING_LAW:-}
NUXT_LEGAL_LEGAL_FORM=${NUXT_LEGAL_LEGAL_FORM:-}
NUXT_LEGAL_REGISTERED_OFFICE=${NUXT_LEGAL_REGISTERED_OFFICE:-}
NUXT_LEGAL_REPRESENTED_BY=${NUXT_LEGAL_REPRESENTED_BY}
NUXT_LEGAL_UID=${NUXT_LEGAL_UID:-}
NUXT_LEGAL_CH_ID=${NUXT_LEGAL_CH_ID:-}
NUXT_LEGAL_EHRA_ID=${NUXT_LEGAL_EHRA_ID:-}
# Data retention (days). Empty = 30 anonymous-doc inactivity / 730 audit
# log / 365 closed abuse reports; 0 = never delete.
NUXT_INACTIVE_DOC_TTL_DAYS=${NUXT_INACTIVE_DOC_TTL_DAYS:-}
NUXT_AUDIT_LOG_RETENTION_DAYS=${NUXT_AUDIT_LOG_RETENTION_DAYS:-}
NUXT_ABUSE_REPORT_RETENTION_DAYS=${NUXT_ABUSE_REPORT_RETENTION_DAYS:-}
# Comma-separated emails promoted to instance admin at their next sign-in.
NUXT_ADMIN_USER_EMAILS=${NUXT_ADMIN_USER_EMAILS:-}

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
TIER_FREE_FEATURE_AI_IMAGE=${TIER_FREE_FEATURE_AI_IMAGE:-}
TIER_FREE_FEATURE_AI_VOICE=${TIER_FREE_FEATURE_AI_VOICE:-}
TIER_FREE_FEATURE_AI_STRONG_MODEL=${TIER_FREE_FEATURE_AI_STRONG_MODEL:-}
TIER_FREE_FEATURE_SSO=${TIER_FREE_FEATURE_SSO:-}
TIER_FREE_FEATURE_AUDIT_LOG=${TIER_FREE_FEATURE_AUDIT_LOG:-}
TIER_FREE_FEATURE_GUESTS=${TIER_FREE_FEATURE_GUESTS:-}
TIER_FREE_FEATURE_BRAND_KIT=${TIER_FREE_FEATURE_BRAND_KIT:-}
TIER_FREE_FEATURE_SHARE_CONTROLS=${TIER_FREE_FEATURE_SHARE_CONTROLS:-}
TIER_FREE_FEATURE_CUSTOM_DOMAINS=${TIER_FREE_FEATURE_CUSTOM_DOMAINS:-}
TIER_PRO_FEATURE_SSO=${TIER_PRO_FEATURE_SSO:-}
TIER_PRO_FEATURE_AUDIT_LOG=${TIER_PRO_FEATURE_AUDIT_LOG:-}
TIER_PRO_FEATURE_GUESTS=${TIER_PRO_FEATURE_GUESTS:-}
TIER_PRO_FEATURE_BRAND_KIT=${TIER_PRO_FEATURE_BRAND_KIT:-}
TIER_TEAM_FEATURE_SSO=${TIER_TEAM_FEATURE_SSO:-}
TIER_TEAM_FEATURE_AUDIT_LOG=${TIER_TEAM_FEATURE_AUDIT_LOG:-}
# Days an unreferenced doc image is kept before the image GC deletes it (0 = off).
NUXT_IMAGE_GC_RETENTION_DAYS=${NUXT_IMAGE_GC_RETENTION_DAYS:-}

# ─── Transactional email (Resend) ───
# Empty RESEND_API_KEY = stub mode (emails logged, not sent). Set both
# for real delivery: the key + a verified-domain From address, e.g.
# markoto <no-reply@markoto.app> (no backticks here - heredoc context).
RESEND_API_KEY=${RESEND_API_KEY:-}
NUXT_EMAIL_FROM=${NUXT_EMAIL_FROM:-}
# stub = log instead of send, even with a key.
NUXT_EMAIL_PROVIDER=${NUXT_EMAIL_PROVIDER:-}

# ─── Edge + sync limits (empty = code defaults; .env.example documents them) ───
NUXT_TRUSTED_PROXY_HOPS=${NUXT_TRUSTED_PROXY_HOPS:-}
RENDERER_ALLOWED_ORIGINS=${RENDERER_ALLOWED_ORIGINS:-}
SYNC_MAX_MESSAGE_BYTES=${SYNC_MAX_MESSAGE_BYTES:-}
SYNC_MAX_UPDATE_BYTES=${SYNC_MAX_UPDATE_BYTES:-}
SYNC_MAX_DOCUMENT_BYTES=${SYNC_MAX_DOCUMENT_BYTES:-}
SYNC_MAX_PREAUTH_BYTES=${SYNC_MAX_PREAUTH_BYTES:-}
SYNC_MAX_PREAUTH_TOTAL_BYTES=${SYNC_MAX_PREAUTH_TOTAL_BYTES:-}
SYNC_AUTH_TIMEOUT_MS=${SYNC_AUTH_TIMEOUT_MS:-}
SYNC_MAX_CONNECTIONS_PER_IP=${SYNC_MAX_CONNECTIONS_PER_IP:-}
COMPACT_THRESHOLD=${COMPACT_THRESHOLD:-}
COMPACT_INTERVAL_MS=${COMPACT_INTERVAL_MS:-}
COMPACT_MAX_DOCS_PER_RUN=${COMPACT_MAX_DOCS_PER_RUN:-}
COMPACT_RETAIN_HISTORY_DAYS=${COMPACT_RETAIN_HISTORY_DAYS:-}

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
