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
postgres_user=v_pguser
postgres_password=v_pgpw
postgres_db=v_pgdb
postgres_host=v_pghost
postgres_port=5433
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
nuxt_stripe_secret_key=v_stripe_sk
nuxt_stripe_webhook_secret=v_stripe_wh
nuxt_stripe_price_pro=v_price_pro
nuxt_stripe_price_max=v_price_max
nuxt_stripe_price_ultra=v_price_ultra
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
