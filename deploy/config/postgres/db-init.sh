#!/bin/sh
# Idempotent database + role bootstrap, run by the `db-init` one-shot
# (deploy/compose/compose.base.yml) before the app and LiteLLM start, on every
# `docker compose up`.
#
# Connects as the ADMIN role (POSTGRES_USER: the bundled image's bootstrap
# superuser, or the managed cluster's admin user) and makes sure that:
#   1. the `litellm` database exists;
#   2. each consumer has its own least-privilege login role when one is
#      configured: the app/sync role owns ONLY the app database, the
#      LiteLLM role owns ONLY the litellm database (no SUPERUSER, CREATEDB
#      or CREATEROLE);
#   3. nobody else can connect to either database (CONNECT/TEMP revoked
#      from PUBLIC), so the LiteLLM role cannot open the app database and
#      vice versa;
#   4. objects created earlier by the admin role (installs that predate
#      separate roles) are handed over to the owning role;
#   5. the app database exists with the `vector` extension (a managed
#      cluster starts without it; the bundled image creates it at init).
#
# On a managed cluster the admin is not a superuser (OVH / Aiven `avnadmin`:
# CREATEDB + CREATEROLE only) and there may be no `postgres` database (Aiven
# has `defaultdb`): the maintenance database is found, not assumed, and the
# admin grants itself SET + INHERIT on each consumer role so it may create
# databases owned by it and read its tables for backups.
#
# A role whose name equals POSTGRES_USER means "no separate role": that
# consumer keeps using the admin role (compose falls back to it when
# POSTGRES_APP_USER / POSTGRES_LITELLM_USER are unset). Passwords are re-applied on every run, so rotating one is: edit
# .env, `docker compose up -d`.
#
# Environment (libpq): PGHOST PGPORT PGUSER PGPASSWORD [PGSSLMODE]
#   ADMIN_DB          maintenance database (default: `postgres`, else
#                     `defaultdb`, whichever exists)
#   APP_DB            app database (POSTGRES_DB)
#   APP_DB_USER       app/sync role   APP_DB_PASSWORD
#   LITELLM_DB        litellm database (default litellm)
#   LITELLM_DB_USER   LiteLLM role    LITELLM_DB_PASSWORD
#
# Values reach SQL only as psql variables (:'name' / format(%I, %L)), never
# by string concatenation, so passwords and names can't inject SQL.
set -eu

: "${PGUSER:?PGUSER (the admin role) is required}"
: "${APP_DB:?APP_DB is required}"
APP_DB_USER="${APP_DB_USER:-$PGUSER}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-}"
LITELLM_DB="${LITELLM_DB:-litellm}"
LITELLM_DB_USER="${LITELLM_DB_USER:-$PGUSER}"
LITELLM_DB_PASSWORD="${LITELLM_DB_PASSWORD:-}"

log() { printf '[db-init] %s\n' "$*"; }

q() { # q DB [psql args...]  (SQL on stdin)
  db="$1"
  shift
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" "$@"
}

# The server may still be starting (managed cluster failover, slow disk).
# template1 exists everywhere; it only serves to find the maintenance
# database (CREATE DATABASE copies template1 and fails while a session is
# connected to it, so nothing else runs there).
i=0
until psql -X -q -d template1 -c 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    log "cannot connect to ${PGHOST:-postgres}:${PGPORT:-5432} as ${PGUSER}" >&2
    exit 1
  fi
  sleep 2
done
if [ -z "${ADMIN_DB:-}" ]; then
  ADMIN_DB="$(psql -X -q -A -t -d template1 -c "SELECT datname FROM pg_database WHERE datname IN ('postgres', 'defaultdb') AND datallowconn ORDER BY datname = 'postgres' DESC LIMIT 1")"
fi
if [ -z "$ADMIN_DB" ]; then
  log "no maintenance database (postgres or defaultdb) on ${PGHOST:-postgres}: set ADMIN_DB" >&2
  exit 1
fi

ensure_role() { # ensure_role NAME PASSWORD
  if [ -z "$2" ]; then
    log "role $1 is configured but its password is empty" >&2
    exit 1
  fi
  q "$ADMIN_DB" -v role="$1" -v pw="$2" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'role')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role')
\gexec
-- Keep the password in sync with .env (rotation = change .env + `up -d`).
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
\gexec
-- Never leave elevated attributes on a consumer role. Only a superuser may
-- change these attributes at all (even to switch them off), so a managed
-- cluster's admin skips this; it created the role without them.
SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'role')
WHERE (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER)
\gexec
-- A non-superuser admin (managed Postgres) needs SET on the role to create
-- a database owned by it and hand objects over to it, and INHERIT to read
-- its tables for backups. Since Postgres 16 the admin that creates a role
-- only gets ADMIN OPTION on it (a membership row without SET or INHERIT),
-- so `MEMBER` alone is not enough: grant both explicitly.
SELECT format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', :'role')
WHERE NOT (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER)
  AND NOT (pg_has_role(CURRENT_USER, :'role', 'SET') AND pg_has_role(CURRENT_USER, :'role', 'USAGE'))
\gexec
SQL
}

ensure_database() { # ensure_database DB OWNER
  q "$ADMIN_DB" -v db="$1" -v owner="$2" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'owner')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'owner')
FROM pg_database d
WHERE d.datname = :'db' AND pg_get_userbyid(d.datdba) <> :'owner'
\gexec
SQL
}

# Hand every object the admin role created in DB over to OWNER: tables,
# views, sequences, functions, types and schemas outside the system
# schemas. Objects that belong to an extension (pgvector's types and
# functions) stay with the extension's owner.
transfer_objects() { # transfer_objects DB OWNER
  q "$1" -v owner="$2" <<'SQL'
SELECT set_config('dbinit.owner', :'owner', false) AS dbinit_owner \gset
DO $$
DECLARE
  target text := current_setting('dbinit.owner');
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname FROM pg_namespace n
    WHERE n.nspowner = CURRENT_USER::regrole
      AND n.nspname NOT IN ('public', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%'
      AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.nspname, target);
  END LOOP;

  FOR r IN
    SELECT c.oid::regclass AS obj, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relowner = CURRENT_USER::regrole
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND n.nspname NOT IN ('information_schema') AND n.nspname NOT LIKE 'pg\_%'
      AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'a', 'i'))
    ORDER BY CASE c.relkind WHEN 'S' THEN 1 ELSE 0 END
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      r.obj, target);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS obj, p.prokind FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proowner = CURRENT_USER::regrole
      AND n.nspname NOT IN ('information_schema') AND n.nspname NOT LIKE 'pg\_%'
      AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE r.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
      r.obj, target);
  END LOOP;

  FOR r IN
    SELECT t.oid::regtype AS obj FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typowner = CURRENT_USER::regrole
      AND t.typtype IN ('e', 'd', 'r')
      AND n.nspname NOT IN ('information_schema') AND n.nspname NOT LIKE 'pg\_%'
      AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype IN ('e', 'i'))
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO %I', r.obj, target);
  END LOOP;
END
$$;
SQL
}

# CONNECT/TEMP for the owner (and superusers) only.
lock_database() { # lock_database DB
  q "$ADMIN_DB" -v db="$1" <<'SQL'
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db')
\gexec
SQL
}

separate_app=0
separate_litellm=0
[ "$APP_DB_USER" != "$PGUSER" ] && separate_app=1
[ "$LITELLM_DB_USER" != "$PGUSER" ] && separate_litellm=1

if [ "$separate_app" = 1 ]; then
  ensure_role "$APP_DB_USER" "$APP_DB_PASSWORD"
fi
ensure_database "$APP_DB" "$APP_DB_USER"
# pgvector is not a trusted extension: a non-superuser owner can't create
# it, so the admin does (the app's migration then finds it present).
q "$APP_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SQL
if [ "$separate_app" = 1 ]; then
  transfer_objects "$APP_DB" "$APP_DB_USER"
  log "app database $APP_DB owned by role $APP_DB_USER"
else
  log "app uses the admin role $PGUSER (set POSTGRES_APP_USER + POSTGRES_APP_PASSWORD for a separate role)"
fi

if [ "$separate_litellm" = 1 ]; then
  ensure_role "$LITELLM_DB_USER" "$LITELLM_DB_PASSWORD"
fi
ensure_database "$LITELLM_DB" "$LITELLM_DB_USER"
if [ "$separate_litellm" = 1 ]; then
  transfer_objects "$LITELLM_DB" "$LITELLM_DB_USER"
  log "litellm database $LITELLM_DB owned by role $LITELLM_DB_USER"
else
  log "LiteLLM uses the admin role $PGUSER (set POSTGRES_LITELLM_USER + POSTGRES_LITELLM_PASSWORD for a separate role)"
fi

# Any separate role makes cross-database access meaningful to block.
if [ "$separate_app" = 1 ] || [ "$separate_litellm" = 1 ]; then
  lock_database "$APP_DB"
  lock_database "$LITELLM_DB"
  log "CONNECT on $APP_DB and $LITELLM_DB revoked from PUBLIC"
fi
