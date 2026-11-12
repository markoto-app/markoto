#!/usr/bin/env bash
# Creates .env from .env.example and fills the secrets the dev stack refuses
# to start without. Idempotent: an existing .env is kept, and only secrets
# that are still empty get a value, so re-running never rotates anything.
# ENV_FILE overrides the target (used to check the result without touching .env).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
target="${ENV_FILE:-.env}"

command -v openssl >/dev/null || { echo "setup-env: openssl is required to generate secrets" >&2; exit 1; }

if [ ! -f "$target" ]; then
  cp .env.example "$target"
  chmod 600 "$target"
  echo "created $target from .env.example"
fi

# Prints the value of KEY= in the env file (empty when unset).
get() { sed -n "s/^$1=//p" "$target" | head -n1; }

# Sets KEY= to a value only while it is empty. The value is hex or sk-hex, so
# it needs no sed escaping.
fill() {
  local key="$1" value="$2"
  if grep -q "^${key}=$" "$target"; then
    sed -i "s|^${key}=$|${key}=${value}|" "$target"
    echo "generated $key"
  elif ! grep -q "^${key}=" "$target"; then
    printf '%s=%s\n' "$key" "$value" >> "$target"
    echo "generated $key"
  fi
}

for key in NUXT_SESSION_PASSWORD NUXT_JWT_SECRET NUXT_INTERNAL_API_SECRET NUXT_ENCRYPTION_KEY NUXT_ALTCHA_HMAC_KEY NUXT_MARKITDOWN_API_SECRET; do
  fill "$key" "$(openssl rand -hex 32)"
done
fill LITELLM_SALT_KEY "sk-$(openssl rand -hex 32)"
fill LITELLM_MASTER_KEY "sk-$(openssl rand -hex 32)"
# The app authenticates to the proxy with the same key the proxy was started with.
fill NUXT_LITELLM_MASTER_KEY "$(get LITELLM_MASTER_KEY)"
