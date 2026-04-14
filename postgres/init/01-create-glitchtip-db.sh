#!/bin/sh
# Postgres entry-point init. Runs ONCE on first bring-up of the pg_data
# volume (idempotent: `docker-entrypoint.sh` only sources /docker-entrypoint-
# initdb.d/ scripts when the data directory is empty).
#
# Creates a dedicated `glitchtip` DB owned by the same `ypad` role. The role
# already has CREATEDB from the default superuser init, so `CREATE DATABASE`
# here is fine. Keeping it shell-based (not SQL) lets us bail early if the
# DB already exists on an out-of-band rerun.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-SQL
  SELECT 'CREATE DATABASE glitchtip OWNER ${POSTGRES_USER}'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'glitchtip')\gexec
SQL
