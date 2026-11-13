#!/usr/bin/env bash
# Reset the STAGING environment to a clean slate before an e2e / smoke run.
#
# Staging is a throwaway TEST environment (no real users). Its Postgres is the
# bundled container of the stack (rootless Podman, owned by the `markoto`
# user that this script logs in as), so we can safely wipe it between runs: the
# whole point of a staging DB is that it's disposable. This:
#   - TRUNCATEs every APP table (the `public` schema), RESTART IDENTITY CASCADE,
#     so each run starts from empty + predictable ids. The drizzle migration
#     ledger lives in the separate `drizzle` schema and is left UNTOUCHED, so
#     the schema stays intact and boot-time migrations see no diff.
#   - FLUSHes Valkey (rate limits, per-doc sync attribution/diff state, sweep
#     locks) so leftover state can't leak between runs.
#
# It does NOT restart the sync-server: e2e runs create fresh docs with new ids,
# so any stale in-memory Y.Doc state is never touched. (If a run ever needs a
# cold sync-server, restart `sync` separately.)
#
# NOT for prod. Guards on the remote DOMAIN containing "staging".
#
# Env:
#   DEPLOY_HOST  (required)                    VPS host / IP
#   DEPLOY_USER  (default: markoto)            SSH user (owner of the stack)
#   SSH_KEY      (default: ~/.ssh/markoto_staging)  private key path
#
# Host keys are verified strictly: the staging host must already be in your
# known_hosts (CI writes the pinned DEPLOY_KNOWN_HOSTS there; locally run
# `ssh-keyscan -t ed25519 <host>` over a trusted path once).
set -euo pipefail

HOST="${DEPLOY_HOST:?DEPLOY_HOST required}"
SSH_USER="${DEPLOY_USER:-markoto}"
KEY="${SSH_KEY:-$HOME/.ssh/markoto_staging}"
# ssh doesn't tilde-expand a path that arrives via a variable, so normalise a
# leading `~/` to $HOME/ ourselves (matters when the caller passes SSH_KEY=~/...).
KEY="${KEY/#\~\//$HOME/}"

echo "[reset-staging-db] resetting ${SSH_USER}@${HOST} ..."
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes "${SSH_USER}@${HOST}" 'bash -se' <<'REMOTE'
set -euo pipefail
cd /opt/markoto
# The stack runs on this user's rootless Podman: no sudo, plain `podman`.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# Safety guard: refuse anything that doesn't look like staging.
DOMAIN=$(awk -F= '/^DOMAIN=/{print $2}' .env | tr -d '"')
case "$DOMAIN" in
  *staging*) : ;;
  *) echo "[reset-staging-db] REFUSING, DOMAIN='${DOMAIN}' is not a staging host" >&2; exit 1 ;;
esac

# Value of KEY from .env: everything after the first '=' (secrets may contain
# '='), minus the single quotes render-env.sh adds around unsafe values.
envval() { sed -n "s/^$1=//p" .env | head -n1 | sed "s/^'\(.*\)'\$/\1/"; }

# Secrets never go on a command line (argv is world-readable in the host
# process list): they are handed to `podman exec` through a 0600 env file.
umask 077
SECRETS_ENV=$(mktemp)
trap 'rm -f "$SECRETS_ENV"' EXIT

PU=$(envval POSTGRES_USER)
PD=$(envval POSTGRES_DB)
printf 'PGPASSWORD=%s\n' "$(envval POSTGRES_PASSWORD)" > "$SECRETS_ENV"

podman exec --env-file "$SECRETS_ENV" markoto-postgres-1 \
  psql -U "$PU" -d "$PD" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename);
  END LOOP;
END $$;
SQL
echo "[reset-staging-db] public schema truncated"

# Best-effort Valkey flush: don't fail the reset if it's unreachable.
# valkey-cli reads the password from REDISCLI_AUTH (no -a on the command line).
printf 'REDISCLI_AUTH=%s\n' "$(envval VALKEY_PASSWORD)" > "$SECRETS_ENV"
if podman exec --env-file "$SECRETS_ENV" markoto-valkey-1 valkey-cli FLUSHALL >/dev/null 2>&1; then
  echo "[reset-staging-db] valkey flushed"
else
  echo "[reset-staging-db] valkey flush skipped (unreachable)"
fi
REMOTE
echo "[reset-staging-db] done."
