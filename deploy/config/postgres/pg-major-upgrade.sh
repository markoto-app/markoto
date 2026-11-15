#!/bin/sh
# Move the bundled Postgres from a pre-18 cluster to Postgres 18.
#
# The stack runs the official Postgres 18 image (pgvector/pgvector), which
# keeps its cluster in a per-major subdirectory (/var/lib/postgresql/18/docker)
# and refuses to start on a volume that still holds an older cluster at its
# root. There is no in-place major upgrade, so this script:
#
#   1. starts the OLD image on the volume (no network) and records the row
#      count of every table, then dumps the whole cluster (pg_dumpall, gzip);
#   2. moves the old cluster's files aside inside the same volume
#      (`pg<major>-pre-upgrade/`: nothing is deleted);
#   3. starts the new `postgres` service (a fresh Postgres 18 cluster),
#      restores the dump and compares the row counts.
#
# Every service is stopped while it runs. Afterwards `compose up -d` starts
# the rest of the stack. A volume without an old cluster (fresh install,
# already upgraded) is left alone, so callers run it on every deploy.
#
# Usage: pg-major-upgrade.sh check     exit 0 = nothing to do, 3 = upgrade needed
#        pg-major-upgrade.sh upgrade   do it (no-op when nothing to do)
#
# Env:
#   COMPOSE     the compose command for this stack, word-split by `eval`
#               (default: docker compose). E.g. markoto-compose on the hosted
#               stack, or "docker compose -f deploy/compose/compose.dev.yml".
#   ENGINE      docker | podman: runs the one-off containers on the same
#               engine (default: docker when present, else podman).
#   BACKUP_DIR  where the dump and the row counts go (default:
#               ./postgres-upgrade). Mode 0700, files 0600.
#   PG_OLD_IMAGE  image of the old cluster (default: the pgvector Postgres 16
#               image markoto shipped before Postgres 18).
#
# Documented in docs/SELF-HOSTING.md#upgrading-to-postgres-18.
set -eu
# Never read the caller's stdin: `compose exec` attaches it even with -T, and
# a deploy that feeds its own script over stdin (deploy.yml) would lose the
# rest of that script. Every psql input below is piped explicitly.
exec < /dev/null

PG_OLD_IMAGE_GIVEN="${PG_OLD_IMAGE:-}"
PG_OLD_IMAGE="${PG_OLD_IMAGE:-docker.io/pgvector/pgvector:pg16@sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f}"
BACKUP_DIR="${BACKUP_DIR:-./postgres-upgrade}"
if [ -z "${ENGINE:-}" ]; then
  if command -v docker > /dev/null 2>&1; then ENGINE=docker; else ENGINE=podman; fi
fi
NEW_MAJOR=18

log() { printf '[pg-major-upgrade] %s\n' "$*"; }
die() { printf '[pg-major-upgrade] error: %s\n' "$*" >&2; exit 1; }
compose() { (eval "${COMPOSE:-docker compose}" '"$@"'); }

# Exact row count of every table of every database, one "<db> <table> <n>"
# line each, sorted. psql runs inside the container given by the arguments.
COUNT_SQL="SELECT format('%I.%I', n.nspname, c.relname),
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
ORDER BY 1;"
row_counts() { # row_counts <command prefix that runs psql in the container>
  dbs="$(printf '%s\n' "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;" \
    | "$@" psql -X -A -t -v ON_ERROR_STOP=1 -U "$PGU" -d postgres)"
  for db in $dbs; do
    printf '%s\n' "$COUNT_SQL" | "$@" psql -X -A -t -F ' ' -v ON_ERROR_STOP=1 -U "$PGU" -d "$db" | sed "s/^/$db /"
  done
}

# Only stacks that run the bundled Postgres (not a managed cluster).
if ! compose config --services | grep -qx postgres; then
  log "no bundled postgres service in this stack: nothing to do"
  exit 0
fi

# The major version of a cluster at the volume root, if any. The new
# image mounts the volume at /var/lib/postgresql, where an old image kept
# its cluster directly.
OLD_MAJOR="$(compose run --rm --no-deps -T --entrypoint sh postgres -c 'cat /var/lib/postgresql/PG_VERSION 2>/dev/null || true' | tr -d '[:space:]')"
case "$OLD_MAJOR" in
  '') log "no pre-$NEW_MAJOR cluster in the postgres volume: nothing to do"; exit 0 ;;
  *[!0-9]*) die "unexpected PG_VERSION '$OLD_MAJOR' at the root of the postgres volume" ;;
esac
if [ "$OLD_MAJOR" -ge "$NEW_MAJOR" ]; then
  die "a Postgres $OLD_MAJOR cluster sits at the root of the postgres volume; expected one under $NEW_MAJOR/docker"
fi
log "the postgres volume holds a Postgres $OLD_MAJOR cluster; this stack runs Postgres $NEW_MAJOR"
if [ "${1:-}" = check ]; then exit 3; fi
[ "${1:-}" = upgrade ] || die "usage: $0 check|upgrade"
if [ "$OLD_MAJOR" != 16 ] && [ -z "$PG_OLD_IMAGE_GIVEN" ]; then
  die "the cluster is Postgres $OLD_MAJOR: set PG_OLD_IMAGE to a pgvector/pgvector:pg$OLD_MAJOR image"
fi

PGU="$(compose run --rm --no-deps -T --entrypoint printenv postgres POSTGRES_USER | tr -d '[:space:]')"
[ -n "$PGU" ] || die "could not read POSTGRES_USER of the postgres service"
PROJECT="$(compose config | sed -n 's/^name: *//p' | head -n 1 | tr -d "\"' ")"
[ -n "$PROJECT" ] || die "could not read the compose project name"
VOLUME="$("$ENGINE" volume ls -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.volume=pg_data")"
case "$VOLUME" in
  '') die "no pg_data volume of project $PROJECT on $ENGINE" ;;
  *[[:space:]]*) die "more than one pg_data volume of project $PROJECT: $VOLUME" ;;
esac

umask 077
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/pg$OLD_MAJOR-$STAMP.sql.gz"
OLD_TMP="$PROJECT-pg$OLD_MAJOR-upgrade"
ASIDE="pg$OLD_MAJOR-pre-upgrade"

log "stopping the stack"
compose stop

log "starting the Postgres $OLD_MAJOR cluster on volume $VOLUME (no network)"
"$ENGINE" rm -f "$OLD_TMP" > /dev/null 2>&1 || true
"$ENGINE" run -d --name "$OLD_TMP" --network none \
  -v "$VOLUME:/var/lib/postgresql/data" "$PG_OLD_IMAGE" > /dev/null
trap '"$ENGINE" rm -f "$OLD_TMP" > /dev/null 2>&1 || true' EXIT
i=0
until "$ENGINE" exec "$OLD_TMP" pg_isready -q -U "$PGU" -d postgres; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || die "the Postgres $OLD_MAJOR cluster did not start ($ENGINE logs $OLD_TMP)"
  sleep 2
done

log "counting rows and dumping to $DUMP"
row_counts "$ENGINE" exec -i "$OLD_TMP" > "$BACKUP_DIR/rows-before-$STAMP.txt"
"$ENGINE" exec "$OLD_TMP" pg_dumpall -U "$PGU" | gzip > "$DUMP"
if ! gzip -dc "$DUMP" | tail -n 5 | grep -q 'PostgreSQL database cluster dump complete'; then
  die "the dump is incomplete; nothing was changed ($DUMP)"
fi
"$ENGINE" rm -f "$OLD_TMP" > /dev/null
trap - EXIT

log "moving the Postgres $OLD_MAJOR files to $ASIDE/ inside the volume"
# shellcheck disable=SC2016 # expanded by the container's shell
"$ENGINE" run --rm --network none -v "$VOLUME:/v" --entrypoint sh "$PG_OLD_IMAGE" -c '
  set -eu
  [ ! -e "/v/$1" ] || { echo "/v/$1 already exists" >&2; exit 1; }
  mkdir "/v/$1"
  for f in /v/* /v/.[!.]*; do
    [ -e "$f" ] || continue
    [ "$f" = "/v/$1" ] && continue
    mv "$f" "/v/$1/"
  done
' sh "$ASIDE"

log "starting Postgres $NEW_MAJOR"
compose up -d --no-deps postgres
i=0
# TCP, not the socket: the init phase runs a socket-only temporary server.
until compose exec -T postgres pg_isready -q -h 127.0.0.1 -U "$PGU" -d postgres > /dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || die "Postgres $NEW_MAJOR did not start (compose logs postgres); the dump is $DUMP"
  sleep 2
done

log "restoring"
# The admin role and the databases the image creates already exist: those
# statements fail ("already exists") and the rest loads into them.
gzip -dc "$DUMP" | compose exec -T postgres psql -X -q -U "$PGU" -d postgres > /dev/null 2> "$BACKUP_DIR/restore-$STAMP.log" || true
if grep 'ERROR:' "$BACKUP_DIR/restore-$STAMP.log" | grep -qv 'already exists'; then
  grep 'ERROR:' "$BACKUP_DIR/restore-$STAMP.log" | grep -v 'already exists' | head -n 20 >&2
  die "the restore reported errors ($BACKUP_DIR/restore-$STAMP.log); the dump is $DUMP, the old files are in $ASIDE/ of volume $VOLUME"
fi

row_counts compose exec -T postgres > "$BACKUP_DIR/rows-after-$STAMP.txt"
if ! cmp -s "$BACKUP_DIR/rows-before-$STAMP.txt" "$BACKUP_DIR/rows-after-$STAMP.txt"; then
  diff "$BACKUP_DIR/rows-before-$STAMP.txt" "$BACKUP_DIR/rows-after-$STAMP.txt" | head -n 20 >&2 || true
  die "row counts differ after the restore; the dump is $DUMP, the old files are in $ASIDE/ of volume $VOLUME"
fi

log "done: $(wc -l < "$BACKUP_DIR/rows-after-$STAMP.txt" | tr -d ' ') tables restored with identical row counts"
log "kept: the dump $DUMP and the Postgres $OLD_MAJOR files in $ASIDE/ of volume $VOLUME."
log "remove them once the instance works (docs/SELF-HOSTING.md#upgrading-to-postgres-18)."
