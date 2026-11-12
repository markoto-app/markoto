#!/usr/bin/env bash
# Proves infra/render-env.sh (the CI path) emits byte-identical KEY=VALUE lines
# to infra/templates/env.j2 (the ansible/laptop path) for the same value set.
# Guards against the two drifting. Run from repo root; needs python3 + jinja2.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

# One distinct sample value per templated var (ansible-var name -> value).
# The .env-key env vars for render-env.sh use the UPPERCASE of the same name.
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
valkey_tls_enabled=True
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

# 1. env.j2 render (ansible var names). ovh_pg_host empty -> PGSSL=disable branch.
jinja_out=$(python3 - <<PY
import jinja2
ctx = dict(line.split('=',1) for line in """$VARS""".strip().splitlines())
ctx['ovh_pg_host'] = ''
ctx['ovh_pg_ca_remote_path'] = '/opt/markoto/secrets/ovh-pg-ca.pem'
t = jinja2.Template(open('infra/templates/env.j2').read(), undefined=jinja2.StrictUndefined,
                    trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)
print(t.render(**ctx))
PY
)

# 2. render-env.sh render (.env-key env vars = UPPERCASE of the same names).
declare -a ENVARGS=()
while IFS='=' read -r k v; do [ -n "$k" ] && ENVARGS+=("$(echo "$k" | tr '[:lower:]' '[:upper:]')=$v"); done <<<"$VARS"
bash_out=$(env -i "${ENVARGS[@]}" bash infra/render-env.sh)

# 3. Compare ONLY the KEY=VALUE lines (ignore header comments, which differ).
if diff <(echo "$jinja_out" | grep -E '^[A-Z]' | sort) \
        <(echo "$bash_out"  | grep -E '^[A-Z]' | sort); then
  echo "PARITY OK — render-env.sh ≡ env.j2 for the KEY=VALUE set"
else
  echo "PARITY FAILED — render-env.sh drifted from env.j2 (diff above)"
  exit 1
fi

# 3a. Managed-Postgres TLS branch: deploy.yml has no PGSSL* inputs; both
#     renderers derive PGSSLROOTCERT / PGSSL / POSTGRES_SSLMODE from
#     OVH_PG_HOST + OVH_PG_CA_REMOTE_PATH (the branch above is the in-stack
#     one, TLS off).
jinja_tls=$(python3 - <<PY
import jinja2
ctx = dict(line.split('=',1) for line in """$VARS""".strip().splitlines())
ctx['ovh_pg_host'] = 'pg.example.test'
ctx['ovh_pg_ca_remote_path'] = '/opt/markoto/secrets/ovh-pg-ca.pem'
t = jinja2.Template(open('infra/templates/env.j2').read(), undefined=jinja2.StrictUndefined,
                    trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)
print(t.render(**ctx))
PY
)
bash_tls=$(env -i "${ENVARGS[@]}" OVH_PG_HOST=pg.example.test OVH_PG_CA_REMOTE_PATH=/opt/markoto/secrets/ovh-pg-ca.pem bash infra/render-env.sh)
if diff <(echo "$jinja_tls" | grep -E '^(PGSSL|POSTGRES_SSLMODE)' | sort) \
        <(echo "$bash_tls"  | grep -E '^(PGSSL|POSTGRES_SSLMODE)' | sort) \
   && echo "$bash_tls" | grep -qx 'POSTGRES_SSLMODE=require'; then
  echo "PG TLS OK — both renderers switch to cert-pinned TLS for a managed host"
else
  echo "PG TLS FAILED — render-env.sh and env.j2 disagree on the managed-Postgres TLS lines"
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
    echo "LEGAL GATE FAILED — render-env.sh rendered without $v"
    exit 1
  fi
done
echo "LEGAL GATE OK — controller address + representative are required"

# 3b. Backup storage falls back to the app's S3 values when no BACKUP_S3_* is
#     set, in BOTH renderers (and identically).
declare -a NOBACKUP=()
for kv in "${ENVARGS[@]}"; do
  case "$kv" in BACKUP_S3_*) ;; *) NOBACKUP+=("$kv") ;; esac
done
fallback_out=$(env -i "${NOBACKUP[@]}" bash infra/render-env.sh)
for pair in ENDPOINT:endpoint BUCKET:bucket ACCESS_KEY:access_key SECRET_KEY:secret_key; do
  suffix="${pair%%:*}"
  want=$(echo "$fallback_out" | grep -E "^NUXT_S3_${suffix}=" | cut -d= -f2-)
  got=$(echo "$fallback_out" | grep -E "^BACKUP_S3_${suffix}=" | cut -d= -f2-)
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "BACKUP FALLBACK FAILED — BACKUP_S3_${suffix} does not default to NUXT_S3_${suffix}"
    exit 1
  fi
done
jinja_fallback=$(python3 - <<PY
import jinja2
ctx = {k: v for k, v in (line.split('=',1) for line in """$VARS""".strip().splitlines()) if not k.startswith('backup_s3_')}
ctx['ovh_pg_host'] = ''
ctx['ovh_pg_ca_remote_path'] = '/opt/markoto/secrets/ovh-pg-ca.pem'
t = jinja2.Template(open('infra/templates/env.j2').read(), undefined=jinja2.StrictUndefined,
                    trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)
print(t.render(**ctx))
PY
)
if diff <(echo "$jinja_fallback" | grep -E '^BACKUP_S3_' | sort) \
        <(echo "$fallback_out"  | grep -E '^BACKUP_S3_' | sort); then
  echo "BACKUP FALLBACK OK — BACKUP_S3_* defaults to NUXT_S3_* in render-env.sh and env.j2"
else
  echo "BACKUP FALLBACK FAILED — render-env.sh and env.j2 disagree on the defaults (diff above)"
  exit 1
fi

# 4. Billing gate: with billing OFF (the default) the Stripe vars are
#    optional; with billing ON an empty Stripe secret must fail the render.
declare -a NOSTRIPE=()
for kv in "${ENVARGS[@]}"; do
  case "$kv" in NUXT_STRIPE_*|NUXT_BILLING_ENABLED=*) ;; *) NOSTRIPE+=("$kv") ;; esac
done
if ! off_out=$(env -i "${NOSTRIPE[@]}" bash infra/render-env.sh 2>&1); then
  echo "BILLING GATE FAILED — render-env.sh refused to render without Stripe vars while billing is off:"
  echo "$off_out"
  exit 1
fi
if ! echo "$off_out" | grep -qx 'NUXT_BILLING_ENABLED=false'; then
  echo "BILLING GATE FAILED — billing must default to off (NUXT_BILLING_ENABLED=false)"
  exit 1
fi
if env -i "${NOSTRIPE[@]}" NUXT_BILLING_ENABLED=true bash infra/render-env.sh >/dev/null 2>&1; then
  echo "BILLING GATE FAILED — render-env.sh rendered with billing ON but no Stripe secrets"
  exit 1
fi
echo "BILLING GATE OK — Stripe vars optional when billing is off, required when on"

# 5. Value safety (render-env.sh only — env.j2 is the legacy laptop path and
#    expects plain values). Every rendered key must survive a compose-style
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
if ! echo "$pad_out" | grep -qxF "NUXT_JWT_SECRET=' padded '"; then
  echo "VALUE SAFETY FAILED - leading/trailing spaces must be single-quoted"
  exit 1
fi
nl_out=$(env -i "${ENVARGS[@]}" "NUXT_JWT_SECRET=trailing
" bash infra/render-env.sh 2>/dev/null)
if ! echo "$nl_out" | grep -qxF "NUXT_JWT_SECRET=trailing"; then
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
