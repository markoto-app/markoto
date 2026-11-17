#!/usr/bin/env bash
# Pins infra/render-env.sh, the one renderer of the hosted .env (used by
# deploy.yml and by the Ansible role): sample values reach the .env
# unchanged, `--keys` lists every input it reads (the Ansible role builds
# its environment from that list), required values fail the render, and
# values compose would mangle are quoted or refused. Run from the repo
# root: bash infra/render-env-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
# Matches read the rendered .env from here-strings, not `echo | grep -q`:
# grep -q exits at the first match, and under pipefail the echo's SIGPIPE
# then fails the check once the .env outgrows one pipe write.

# One distinct sample value per input, by Ansible variable name (the
# lower-case .env key, as the role passes them); render-env.sh gets the
# UPPERCASE names.
read -r -d '' VARS <<'PY' || true
nuxt_session_password=v_session
nuxt_jwt_secret=v_jwt
nuxt_internal_api_secret=v_internal
nuxt_jwt_secret_previous=v_jwt_prev
nuxt_internal_api_secret_previous=v_internal_prev
nuxt_encryption_key=v_encryption
nuxt_encryption_key_previous=v_encryption_prev
nuxt_altcha_hmac_key=v_altcha
nuxt_markitdown_api_secret=v_markitdown
nuxt_publish_domains_target=pages.example.test
nuxt_publish_traefik_token=v_traefik_token
nuxt_publish_pages_host=pages.example.org
nuxt_legal_controller_name=v_controller
nuxt_legal_controller_address=Street 1, 8000 Zurich
nuxt_legal_privacy_contact_email=privacy@example.test
nuxt_legal_abuse_contact_email=abuse@example.test
nuxt_legal_governing_law=v_law
nuxt_legal_legal_form=v_form
nuxt_legal_registered_office=v_office
nuxt_legal_represented_by=v_representative
nuxt_legal_uid=v_uid
nuxt_legal_ch_id=v_chid
nuxt_legal_ehra_id=v_ehra
nuxt_admin_user_emails=a@example.test,b@example.test
nuxt_email_provider=stub
nuxt_inactive_doc_ttl_days=60
nuxt_audit_log_retention_days=800
nuxt_abuse_report_retention_days=400
nuxt_ai_realtime_model=v_realtime
nuxt_trusted_proxy_hops=2
renderer_allowed_origins=https://img.example.test
sync_max_message_bytes=111
sync_max_update_bytes=222
sync_max_document_bytes=333
sync_max_preauth_bytes=444
sync_max_preauth_total_bytes=555
sync_auth_timeout_ms=666
sync_max_connections_per_ip=77
compact_threshold=88
compact_interval_ms=99
compact_max_docs_per_run=11
postgres_user=v_pguser
postgres_password=v_pgpw
postgres_db=v_pgdb
postgres_host=v_pghost
postgres_port=5433
postgres_app_user=v_pgappuser
postgres_app_password=v_pgapppw
postgres_litellm_user=v_pgllmuser
postgres_litellm_password=v_pgllmpw
valkey_password=v_vkpw
valkey_db=2
nuxt_s3_endpoint=v_s3ep
nuxt_s3_access_key=v_s3ak
nuxt_s3_secret_key=v_s3sk
nuxt_s3_bucket=v_s3bucket
nuxt_ai_dictate_jwt_secret=v_dictate
litellm_master_key=v_llmaster
litellm_salt_key=v_llsalt
jina_ai_api_key=v_jina
staan_api_key=v_staan
mistral_api_key=v_mistral
bfl_api_key=v_bfl
nuxt_litellm_embeddings_model=custom-embeddings
nuxt_litellm_embeddings_dims=1536
nuxt_litellm_embeddings_send_dimensions=true
nuxt_litellm_embeddings_task_hints=false
embeddings_upstream_model=openai/text-embedding-3-small
embeddings_upstream_api_base=https://emb.example.test/v1
embeddings_upstream_api_key=v_embkey
nuxt_ai_default_chat_model=v_chat_model
nuxt_ai_default_chat_base_url=https://chat.example.test/v1
nuxt_ai_default_chat_api_key=v_chat_key
nuxt_ai_default_chat_vision=false
nuxt_ai_default_image_model=v_image_model
nuxt_ai_default_image_base_url=https://image.example.test/v1
nuxt_ai_default_image_api_key=v_image_key
nuxt_ai_default_transcribe_model=v_transcribe_model
nuxt_ai_default_transcribe_base_url=https://stt.example.test/v1
nuxt_ai_default_transcribe_api_key=v_transcribe_key
nuxt_ai_byok_allowed_base_urls=https://a.example.test/v1,https://b.example.test/v1
nuxt_ai_byok_allow_private_urls=True
nuxt_billing_enabled=false
nuxt_plans_coming_soon=true
nuxt_site_indexable=false
nuxt_canonical_site_url=https://markoto.app
tier_free_litellm_budget_usd=7
nuxt_free_tier_total_budget_usd=250
tier_free_workspaces_owned=3
tier_free_knowledge_files=40
tier_free_knowledge_bytes_per_workspace=1000
tier_free_knowledge_bytes_per_user=2000
tier_free_image_bytes_per_user=3000
tier_free_members_per_workspace=4
tier_free_history_days=14
tier_free_saved_themes=5
tier_free_import_max_bytes=2048
tier_free_web_tools_per_day=11
tier_free_mcp_tool_calls_per_day=77
tier_free_feature_custom_css=true
tier_free_feature_mcp_write=true
nuxt_image_gc_retention_days=45
nuxt_stripe_secret_key=v_stripe_sk
nuxt_stripe_webhook_secret=v_stripe_wh
nuxt_stripe_lookup_key_prefix=v_prefix
nuxt_stripe_price_ids=v_price_ids
nuxt_stripe_automatic_tax=1
nuxt_stripe_managed_payments=true
nuxt_billing_notify_email=billing@example.test
resend_api_key=v_resend
nuxt_email_from=markoto <v@example.test>
nuxt_oauth_github_client_id=v_ghid
nuxt_oauth_github_client_secret=v_ghsec
nuxt_oauth_google_client_id=v_ggid
nuxt_oauth_google_client_secret=v_ggsec
nuxt_public_sentry_dsn=v_pubdsn
sentry_dsn=v_dsn
domain=example.test
acme_email=a@example.test
registry=ghcr.io/x
image_tag=v9.9.9
backup_interval_seconds=1234
backup_retention_count=7
backup_gpg_passphrase=v_gpg
backup_s3_endpoint=https://backup-s3.example.test
backup_s3_bucket=v_backup_bucket
backup_s3_access_key=v_backup_ak
backup_s3_secret_key=v_backup_sk
backup_s3_region=v_backup_region
backup_s3_prefix=v/backup/prefix
PY

declare -a ENVARGS=()
while IFS='=' read -r k v; do [[ -n "$k" ]] && ENVARGS+=("$(echo "$k" | tr '[:lower:]' '[:upper:]')=$v"); done <<<"$VARS"
bash_out=$(env -i "${ENVARGS[@]}" bash infra/render-env.sh)

# 1. Every sample value reaches the .env unchanged.
while IFS='=' read -r k v; do
  [[ -n "$k" ]] || continue
  key=$(echo "$k" | tr '[:lower:]' '[:upper:]')
  # Booleans compose hands to the app verbatim are normalised to lower case.
  case "$key" in NUXT_AI_BYOK_ALLOW_PRIVATE_URLS | NUXT_SITE_INDEXABLE) v=$(echo "$v" | tr '[:upper:]' '[:lower:]') ;; esac
  if ! grep -qxF "${key}=${v}" <<<"$bash_out"; then
    echo "PASSTHROUGH FAILED: ${key} is not rendered as its input value"
    exit 1
  fi
done <<<"$VARS"
echo "PASSTHROUGH OK: every sample input is rendered unchanged"

# 2. `--keys` lists every variable the script reads from its environment
#    (a `${NAME…}` it does not assign itself before use), so the Ansible
#    path passes them all.
keys=$(bash infra/render-env.sh --keys | sort -u)
read_vars=$(grep -oE '\$\{[A-Z][A-Z0-9_]*' infra/render-env.sh | cut -c3- | grep -vx INPUTS | sort -u)
missing=$(comm -13 <(echo "$keys") <(echo "$read_vars") || true)
if [[ -n "$missing" ]]; then
  echo "KEYS FAILED: read but not listed in INPUTS (--keys): $missing"
  exit 1
fi
echo "KEYS OK: --keys covers every variable render-env.sh reads"

# 3. The stack markoto-compose uses on the host: the production stack on
#    rootless Podman (its overlay), the Postgres container only for the
#    in-stack host name, never with a managed cluster.
if ! grep -qx 'COMPOSE_FILE=deploy/compose/compose.prod.yml:deploy/compose/compose.podman.yml' <<<"$bash_out"; then
  echo "COMPOSE_FILE FAILED: the .env must name the production stack and the Podman overlay"
  exit 1
fi
declare -a BUNDLEDPG=()
for kv in "${ENVARGS[@]}"; do
  case "$kv" in POSTGRES_HOST=*) BUNDLEDPG+=("POSTGRES_HOST=postgres") ;; *) BUNDLEDPG+=("$kv") ;; esac
done
bundled_out=$(env -i "${BUNDLEDPG[@]}" bash infra/render-env.sh)
if grep -qx 'COMPOSE_PROFILES=bundled-postgres' <<<"$bundled_out" \
   && grep -qx 'COMPOSE_PROFILES=' <<<"$bash_out"; then
  echo "PG PROFILE OK, Postgres container for the in-stack host only"
else
  echo "PG PROFILE FAILED, COMPOSE_PROFILES must be bundled-postgres exactly when POSTGRES_HOST=postgres"
  exit 1
fi
if env -i "${BUNDLEDPG[@]}" OVH_PG_HOST=pg.example.test bash infra/render-env.sh >/dev/null 2>&1; then
  echo "PG PROFILE FAILED, a managed OVH_PG_HOST with POSTGRES_HOST=postgres must not render"
  exit 1
fi

# 3a. Managed-Postgres TLS: PGSSLROOTCERT / PGSSL / POSTGRES_SSLMODE derive
#     from OVH_PG_HOST + OVH_PG_CA_REMOTE_PATH (deploy.yml has no PGSSL*
#     inputs); without a managed host TLS is off (in-stack Postgres).
bash_tls=$(env -i "${ENVARGS[@]}" OVH_PG_HOST=pg.example.test OVH_PG_CA_REMOTE_PATH=/opt/markoto/secrets/ovh-pg-ca.pem bash infra/render-env.sh)
if grep -qx 'POSTGRES_SSLMODE=require' <<<"$bash_tls" \
   && grep -qx 'PGSSLROOTCERT=/opt/markoto/secrets/ovh-pg-ca.pem' <<<"$bash_tls" \
   && grep -qx 'POSTGRES_SSLMODE=disable' <<<"$bash_out" \
   && grep -qx 'PGSSL=disable' <<<"$bash_out"; then
  echo "PG TLS OK, cert-pinned TLS for a managed host, off for the in-stack one"
else
  echo "PG TLS FAILED, wrong managed-Postgres TLS lines"
  exit 1
fi

# 3c. The legal surfaces are always on in the rendered stack, so a missing
#     controller address or representative must fail the render (not the boot).
for v in NUXT_LEGAL_CONTROLLER_ADDRESS NUXT_LEGAL_REPRESENTED_BY; do
  declare -a NOLEGAL=()
  for kv in "${ENVARGS[@]}"; do
    case "$kv" in "$v="*) ;; *) NOLEGAL+=("$kv") ;; esac
  done
  if env -i "${NOLEGAL[@]}" bash infra/render-env.sh >/dev/null 2>&1; then
    echo "LEGAL GATE FAILED, render-env.sh rendered without $v"
    exit 1
  fi
done
echo "LEGAL GATE OK, controller address + representative are required"

# 3d. Staging's edge login: empty by default (prod), a bcrypt htpasswd line
#     is written single-quoted (compose keeps its `$` literal), anything
#     else fails the render instead of breaking Traefik's routers.
# A placeholder in htpasswd shape (no real password behind it), assembled
# here so secret scanners do not read it as a leaked hash.
edge_line="staging:\$2y\$05\$$(printf 'x%.0s' {1..53})"
edge_out=$(env -i "${ENVARGS[@]}" EDGE_BASIC_AUTH_USERS="$edge_line" bash infra/render-env.sh)
if grep -qx 'EDGE_BASIC_AUTH_USERS=' <<<"$bash_out" \
   && grep -qxF "EDGE_BASIC_AUTH_USERS='${edge_line}'" <<<"$edge_out" \
   && ! env -i "${ENVARGS[@]}" EDGE_BASIC_AUTH_USERS='staging:plain-password' bash infra/render-env.sh >/dev/null 2>&1; then
  echo "EDGE LOGIN OK, off by default, bcrypt lines quoted, anything else refused"
else
  echo "EDGE LOGIN FAILED, wrong EDGE_BASIC_AUTH_USERS handling"
  exit 1
fi

# 3b. Backup storage falls back to the app's S3 values when no BACKUP_S3_* is
#     set.
declare -a NOBACKUP=()
for kv in "${ENVARGS[@]}"; do
  case "$kv" in BACKUP_S3_*) ;; *) NOBACKUP+=("$kv") ;; esac
done
fallback_out=$(env -i "${NOBACKUP[@]}" bash infra/render-env.sh)
for pair in ENDPOINT:endpoint BUCKET:bucket ACCESS_KEY:access_key SECRET_KEY:secret_key; do
  suffix="${pair%%:*}"
  want=$(echo "$fallback_out" | grep -E "^NUXT_S3_${suffix}=" | cut -d= -f2-)
  got=$(echo "$fallback_out" | grep -E "^BACKUP_S3_${suffix}=" | cut -d= -f2-)
  if [[ -z "$want" ]] || [[ "$want" != "$got" ]]; then
    echo "BACKUP FALLBACK FAILED, BACKUP_S3_${suffix} does not default to NUXT_S3_${suffix}"
    exit 1
  fi
done
echo "BACKUP FALLBACK OK, BACKUP_S3_* defaults to NUXT_S3_*"

# 4. Billing gate: with billing OFF (the default) the Stripe vars are
#    optional; with billing ON an empty Stripe secret must fail the render.
declare -a NOSTRIPE=()
for kv in "${ENVARGS[@]}"; do
  case "$kv" in NUXT_STRIPE_*|NUXT_BILLING_ENABLED=*) ;; *) NOSTRIPE+=("$kv") ;; esac
done
if ! off_out=$(env -i "${NOSTRIPE[@]}" bash infra/render-env.sh 2>&1); then
  echo "BILLING GATE FAILED, render-env.sh refused to render without Stripe vars while billing is off:"
  echo "$off_out"
  exit 1
fi
if ! grep -qx 'NUXT_BILLING_ENABLED=false' <<<"$off_out"; then
  echo "BILLING GATE FAILED, billing must default to off (NUXT_BILLING_ENABLED=false)"
  exit 1
fi
if env -i "${NOSTRIPE[@]}" NUXT_BILLING_ENABLED=true bash infra/render-env.sh >/dev/null 2>&1; then
  echo "BILLING GATE FAILED, render-env.sh rendered with billing ON but no Stripe secrets"
  exit 1
fi
echo "BILLING GATE OK, Stripe vars optional when billing is off, required when on"

# 5. Value safety. Every rendered key must survive a compose-style
#    parse byte-for-byte even when the input is full of characters that
#    compose would interpolate, truncate or mangle; values that cannot be
#    represented (single quote, embedded newline) must fail the render.
NASTY="a b\$home #c\"d\\e\`f\`g"
declare -a NASTYARGS=()
for kv in "${ENVARGS[@]}"; do
  case "$kv" in
    # Hostnames spliced into URLs / Traefik rules are validated instead.
    DOMAIN=*|NUXT_PUBLISH_PAGES_HOST=*|NUXT_BILLING_ENABLED=*) NASTYARGS+=("$kv") ;;
    *) NASTYARGS+=("${kv%%=*}=$NASTY") ;;
  esac
done
nasty_out=$(env -i "${NASTYARGS[@]}" bash infra/render-env.sh)
NASTY="$NASTY" NASTY_OUT="$nasty_out" NASTY_KEYS="$(printf '%s\n' "${NASTYARGS[@]}" | grep -F "=$NASTY" | cut -d= -f1 | tr '\n' ' ')" python3 - <<'PY'
import os, sys

nasty = os.environ['NASTY']
keys = set(os.environ['NASTY_KEYS'].split())
unsafe = set('$#"\\`')
bad = []
seen = set()
for line in os.environ['NASTY_OUT'].splitlines():
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, raw = line.split('=', 1)
    if raw.startswith("'"):
        # compose: a single-quoted value is taken literally
        if len(raw) < 2 or not raw.endswith("'") or "'" in raw[1:-1]:
            bad.append((key, 'malformed single-quoted value'))
            continue
        value = raw[1:-1]
    else:
        value = raw
        if unsafe & set(raw) or raw != raw.strip():
            bad.append((key, 'unquoted value with characters compose would mangle'))
            continue
    if key in keys:
        seen.add(key)
        if value != nasty:
            bad.append((key, 'value changed by quoting'))
missing = keys - seen
if missing:
    bad.extend((k, 'not rendered / not round-tripped') for k in sorted(missing))
if bad:
    for key, why in bad:
        print('VALUE SAFETY FAILED - %s: %s' % (key, why))
    sys.exit(1)
print('VALUE SAFETY OK - %d keys survive a compose-style parse byte-for-byte' % len(seen))
PY

# Leading/trailing spaces are quoted too; a trailing newline (pasted secret) is
# stripped; embedded newlines and single quotes fail loudly.
pad_out=$(env -i "${ENVARGS[@]}" "NUXT_JWT_SECRET= padded " bash infra/render-env.sh)
if ! grep -qxF "NUXT_JWT_SECRET=' padded '" <<<"$pad_out"; then
  echo "VALUE SAFETY FAILED - leading/trailing spaces must be single-quoted"
  exit 1
fi
nl_out=$(env -i "${ENVARGS[@]}" "NUXT_JWT_SECRET=trailing
" bash infra/render-env.sh 2>/dev/null)
if ! grep -qxF "NUXT_JWT_SECRET=trailing" <<<"$nl_out"; then
  echo "VALUE SAFETY FAILED - a trailing newline must be stripped, not emitted"
  exit 1
fi
if env -i "${ENVARGS[@]}" "NUXT_JWT_SECRET=a
b=c" bash infra/render-env.sh >/dev/null 2>&1; then
  echo "VALUE SAFETY FAILED - an embedded newline (key injection) must fail the render"
  exit 1
fi
if env -i "${ENVARGS[@]}" "NUXT_JWT_SECRET=it's" bash infra/render-env.sh >/dev/null 2>&1; then
  echo "VALUE SAFETY FAILED - a single quote must fail the render"
  exit 1
fi
if env -i "${ENVARGS[@]}" "DOMAIN=evil.test\$(id)" bash infra/render-env.sh >/dev/null 2>&1; then
  echo "VALUE SAFETY FAILED - a non-hostname DOMAIN must fail the render"
  exit 1
fi
if env -i "${ENVARGS[@]}" "NUXT_PUBLISH_PAGES_HOST=pages.example.org\`) || Host(\`evil.test" bash infra/render-env.sh >/dev/null 2>&1; then
  echo "VALUE SAFETY FAILED - a non-hostname NUXT_PUBLISH_PAGES_HOST must fail the render"
  exit 1
fi
if env -i "${ENVARGS[@]}" "NUXT_PUBLISH_PAGES_HOST=" bash infra/render-env.sh >/dev/null 2>&1; then
  echo "VALUE SAFETY FAILED - an empty NUXT_PUBLISH_PAGES_HOST must fail the render"
  exit 1
fi
echo "VALUE SAFETY OK - spaces quoted, trailing newline stripped, newline/quote/bad DOMAIN/pages host rejected"

# Analytics (docs/operations-analytics.md): UMAMI_APP_SECRET turns on the
# `analytics` profile and needs the dashboard host + its edge login; a
# website id without Umami, a bad host or a bad login line fail the render.
# shellcheck disable=SC2016 # a literal bcrypt hash, not an expansion
UMAMI_LOGIN='stats:$2y$05$abcdefghijklmnopqrstuuW2KvOH6tIrWw6e0kJw4l7j6HnJ6O9H2'
UMAMI_ID='0d2c6a3e-1b4f-4a8e-9c0d-123456789abc'
declare -a UMAMIARGS=("UMAMI_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" "UMAMI_HOST=stats.example.test" "UMAMI_BASIC_AUTH_USERS=$UMAMI_LOGIN" "POSTGRES_UMAMI_USER=v_pgumami" "POSTGRES_UMAMI_PASSWORD=v_pgumamipw" "NUXT_PUBLIC_ANALYTICS_WEBSITE_ID=$UMAMI_ID" "NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS=True")
umami_out=$(env -i "${ENVARGS[@]}" "${UMAMIARGS[@]}" bash infra/render-env.sh)
for want in 'COMPOSE_PROFILES=analytics' 'UMAMI_HOST=stats.example.test' "UMAMI_BASIC_AUTH_USERS='$UMAMI_LOGIN'" 'POSTGRES_UMAMI_USER=v_pgumami' "NUXT_PUBLIC_ANALYTICS_WEBSITE_ID=$UMAMI_ID" 'NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS=true'; do
  if ! grep -qxF "$want" <<<"$umami_out"; then
    echo "ANALYTICS FAILED - expected line: $want"
    exit 1
  fi
done
umami_bundled=$(env -i "${BUNDLEDPG[@]}" "${UMAMIARGS[@]}" bash infra/render-env.sh)
if ! grep -qx 'COMPOSE_PROFILES=bundled-postgres,analytics' <<<"$umami_bundled"; then
  echo "ANALYTICS FAILED - bundled Postgres + analytics must render both profiles"
  exit 1
fi
for bad in "UMAMI_HOST=" "UMAMI_HOST=stats.example.test\`) || Host(\`evil.test" "UMAMI_BASIC_AUTH_USERS=" "UMAMI_BASIC_AUTH_USERS=stats:plain" "UMAMI_APP_SECRET=short" "NUXT_PUBLIC_ANALYTICS_WEBSITE_ID=not-a-uuid" "POSTGRES_UMAMI_PASSWORD="; do
  if env -i "${ENVARGS[@]}" "${UMAMIARGS[@]}" "$bad" bash infra/render-env.sh >/dev/null 2>&1; then
    echo "ANALYTICS FAILED - must not render with $bad"
    exit 1
  fi
done
if env -i "${ENVARGS[@]}" "NUXT_PUBLIC_ANALYTICS_WEBSITE_ID=$UMAMI_ID" bash infra/render-env.sh >/dev/null 2>&1; then
  echo "ANALYTICS FAILED - a website id without UMAMI_APP_SECRET must not render"
  exit 1
fi
if ! grep -qx 'COMPOSE_PROFILES=' <<<"$bash_out" || ! grep -qx 'UMAMI_APP_SECRET=' <<<"$bash_out"; then
  echo "ANALYTICS FAILED - without UMAMI_APP_SECRET there is no analytics profile"
  exit 1
fi
echo "ANALYTICS OK - profile, dashboard host + login checks, website id needs Umami"
