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
#     the schema stays intact and boot-time migrations see no diff. It then
#     counts the rows of every public table and fails if any remain.
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
# RESET_SCOPE=valkey clears only Valkey and leaves Postgres alone (what the
# staging gate uses, so signed-in test accounts survive a release).
set -euo pipefail

HOST="${DEPLOY_HOST:?DEPLOY_HOST required}"
SSH_USER="${DEPLOY_USER:-markoto}"
KEY="${SSH_KEY:-$HOME/.ssh/markoto_staging}"
# ssh doesn't tilde-expand a path that arrives via a variable, so normalise a
# leading `~/` to $HOME/ ourselves (matters when the caller passes SSH_KEY=~/...).
KEY="${KEY/#\~\//$HOME/}"

echo "[reset-staging-db] resetting ${SSH_USER}@${HOST} ..."
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes "${SSH_USER}@${HOST}" \
  RESET_SCOPE="${RESET_SCOPE:-all}" 'bash -se' <<'REMOTE'
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

PG_CONTAINER="${PG_CONTAINER:-markoto-postgres-1}"
VALKEY_CONTAINER="${VALKEY_CONTAINER:-markoto-valkey-1}"

if [ "${RESET_SCOPE}" = "valkey" ]; then
  echo "[reset-staging-db] RESET_SCOPE=valkey: Postgres left untouched"
else
# `-i`: without it `podman exec` gives psql no stdin, psql reads an empty
# script and exits 0, and nothing is truncated.
podman exec -i --env-file "$SECRETS_ENV" "$PG_CONTAINER" \
  psql -U "$PU" -d "$PD" -v ON_ERROR_STOP=1 -q <<'SQL'
SET client_min_messages = warning;
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename);
  END LOOP;
END $$;
SQL
# Verify instead of trusting the exit code: every table of the public schema
# must be empty now. Prints `<table> <rows>` for each one that is not.
LEFT=$(podman exec -i --env-file "$SECRETS_ENV" "$PG_CONTAINER" \
  psql -U "$PU" -d "$PD" -v ON_ERROR_STOP=1 -At -F ' ' <<'SQL'
SELECT tablename, n
FROM (
  SELECT tablename,
    (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', tablename), false, true, '')))[1]::text::bigint AS n
  FROM pg_tables WHERE schemaname = 'public'
) t
WHERE n > 0
ORDER BY tablename;
SQL
)
if [ -n "$LEFT" ]; then
  echo "[reset-staging-db] FAILED, rows remain in:" >&2
  printf '%s\n' "$LEFT" >&2
  exit 1
fi
TABLES=$(podman exec -i --env-file "$SECRETS_ENV" "$PG_CONTAINER" \
  psql -U "$PU" -d "$PD" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';
SQL
)
if [ "${TABLES:-0}" -eq 0 ]; then
  echo "[reset-staging-db] FAILED, no tables found in the public schema (wrong database?)" >&2
  exit 1
fi
echo "[reset-staging-db] public schema truncated and verified empty (${TABLES} tables)"
fi

# Best-effort Valkey flush: don't fail the reset if it's unreachable.
# valkey-cli reads the password from REDISCLI_AUTH (no -a on the command line).
printf 'REDISCLI_AUTH=%s\n' "$(envval VALKEY_PASSWORD)" > "$SECRETS_ENV"
if podman exec --env-file "$SECRETS_ENV" "$VALKEY_CONTAINER" valkey-cli FLUSHALL >/dev/null 2>&1; then
  echo "[reset-staging-db] valkey flushed"
else
  echo "[reset-staging-db] valkey flush skipped (unreachable)"
fi
REMOTE
echo "[reset-staging-db] done."
