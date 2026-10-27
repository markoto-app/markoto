#!/bin/sh
# Periodic Postgres → S3 backup. Pipes pg_dump through gzip + gpg
# (symmetric AES-256, passphrase from env) and uploads to
# s3://$S3_BUCKET/$S3_PREFIX/{timestamp}.sql.gz.gpg (S3_PREFIX defaults to
# backups/postgres), then prunes anything beyond BACKUP_RETENTION_COUNT
# newest backups.
#
# S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY / S3_REGION /
# S3_PREFIX are the backup storage settings. Compose fills them from
# BACKUP_S3_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY,REGION,PREFIX} (falling
# back to the app's NUXT_S3_* values until a dedicated backup bucket exists);
# only this sidecar ever receives them.
#
# Exit status: `--once` exits non-zero when the backup failed, so the host
# cron (roles/backup_cron) can alert. The long-running
# loop logs the failure and retries next interval.
#
# Why gpg on top of S3 SSE? S3 server-side encryption protects against
# physical-disk theft AT the storage provider; it does NOT protect
# against a leaked S3 access key, an accidentally-public bucket, or a
# malicious provider employee. Client-side symmetric encryption with a
# key the storage provider never sees adds the missing belt-and-braces
# layer. Restore needs the same passphrase.
#
# Same script works against any S3-compatible endpoint (SeaweedFS in dev,
# Infomaniak / R2 / AWS in prod) — only env changes.
#
# Restore: see docs/DEPLOY.md §6 — `gpg --decrypt | gunzip | psql`.
# Runs as an unprivileged user (see the Dockerfile): HOME and the gpg home
# live under /tmp.

set -e
# pipefail makes a pipeline return the FIRST non-zero exit, not just the
# last stage's. Without it, `pg_dump | gzip | gpg` reports success as long
# as gpg succeeds — even if pg_dump died mid-stream and produced a
# truncated dump. That's how a silently-corrupt backup gets uploaded and
# looks fine. Verified supported by busybox ash in postgres:16-alpine
# (the base image); it is NOT portable POSIX, so keep the alpine base.
set -o pipefail

# Writable homes for the unprivileged user (aws CLI config, gpg keyring).
: "${HOME:=/tmp}"
export HOME
GNUPGHOME="${GNUPGHOME:-/tmp/.gnupg}"
export GNUPGHOME
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_USER:=ypad}"
: "${POSTGRES_DB:=ypad}"
: "${S3_BUCKET:=ypad}"
: "${BACKUP_INTERVAL_SECONDS:=86400}"   # 24 h
: "${BACKUP_RETENTION_COUNT:=30}"
: "${S3_REGION:=us-east-1}"
: "${S3_PREFIX:=backups/postgres}"
# Normalise: no leading/trailing slashes.
S3_PREFIX=$(printf '%s' "$S3_PREFIX" | sed 's#^/*##; s#/*$##')
AWS_DEFAULT_REGION="$S3_REGION"
export AWS_DEFAULT_REGION

if [ -z "$PGPASSWORD" ] || [ -z "$S3_ENDPOINT" ] || [ -z "$S3_ACCESS_KEY" ] || [ -z "$S3_SECRET_KEY" ]; then
  echo "[backup] Missing required env (PGPASSWORD / S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY). Exiting." >&2
  exit 1
fi

if [ -z "$BACKUP_GPG_PASSPHRASE" ]; then
  echo "[backup] BACKUP_GPG_PASSPHRASE is required. Generate with: openssl rand -base64 48" >&2
  echo "[backup] WARNING: rotating this passphrase invalidates older backups for restore." >&2
  exit 1
fi

# Server-side encryption header (see the upload below). Default AES256;
# S3_SSE=none (or empty) omits it.
sse="${S3_SSE-AES256}"
case "$sse" in none | NONE) sse="" ;; esac

upload_backup() {
  if [ -n "$sse" ]; then
    aws --endpoint-url "$S3_ENDPOINT" s3 cp "$1" "$2" --sse "$sse" --no-progress
  else
    aws --endpoint-url "$S3_ENDPOINT" s3 cp "$1" "$2" --no-progress
  fi
}

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"

backup_once() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  key="${S3_PREFIX}/${ts}.sql.gz.gpg"
  tmp="/tmp/${ts}.sql.gz.gpg"
  status=0

  echo "[backup] $(date -u +%FT%TZ) Starting pg_dump → s3://${S3_BUCKET}/${key}"
  # Pipeline: pg_dump | gzip | gpg --symmetric AES256 | tmpfile.
  # The passphrase is fed via fd 3 instead of --passphrase "$VAR" so it
  # never appears in `ps`/`/proc/<pid>/cmdline`. --batch + --pinentry-mode
  # loopback keeps gpg fully non-interactive in a containerised setting.
  # `set -o pipefail` (above) makes this `if` false if ANY stage fails —
  # so a mid-pipeline pg_dump failure skips the upload instead of shipping
  # a truncated dump. A post-pipeline size floor (below) is the second
  # guard against a pg_dump that exits 0 but produced too little.
  if pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --no-owner --clean --if-exists 2>/tmp/pg_dump.err \
        | gzip \
        | gpg --batch --yes --quiet \
              --pinentry-mode loopback \
              --symmetric --cipher-algo AES256 \
              --passphrase-fd 3 \
              -o "$tmp" 3<<EOF_PASSPHRASE
$BACKUP_GPG_PASSPHRASE
EOF_PASSPHRASE
  then
    # Size floor: a real encrypted dump — even of a near-empty schema — is
    # comfortably over 1 KB. A tmpfile below the floor means the pipeline
    # produced almost nothing (a pg_dump that exited 0 but wrote a stub, or
    # a gpg of an empty stream); refuse to upload it over a good backup.
    # (Don't `return` here — this function is called bare under `set -e`,
    # so a non-zero return would kill the whole backup loop. Skip the
    # upload and let the next interval retry.)
    bytes=$(wc -c < "$tmp" 2>/dev/null || echo 0)
    if [ "$bytes" -lt 1024 ]; then
      echo "[backup] Refusing to upload — dump is implausibly small (${bytes} bytes). Treating as failure; will retry next interval." >&2
      status=1
    else
      size=$(du -h "$tmp" | cut -f1)
      # --sse AES256 is bucket-default-encryption defense-in-depth: even
      # though the file body is already gpg-encrypted, the S3 object's
      # at-rest layer adds the second key. Provider-managed key encrypts
      # ciphertext blob; passphrase decrypts the contents. Either alone
      # is insufficient for restore. S3_SSE=none drops the header for
      # backends without SSE-S3 (SeaweedFS answers it with InternalError),
      # same switch as the renderer.
      if upload_backup "$tmp" "s3://${S3_BUCKET}/${key}"; then
        echo "[backup] Uploaded ${size} (encrypted) to s3://${S3_BUCKET}/${key}"
      else
        echo "[backup] S3 upload FAILED for ${key}" >&2
        status=1
      fi
    fi
  else
    echo "[backup] pg_dump | gpg pipeline FAILED:" >&2
    cat /tmp/pg_dump.err >&2
    status=1
  fi
  rm -f "$tmp" /tmp/pg_dump.err

  # Retention: keep newest N, drop the rest. ISO-8601-ish timestamps sort
  # lexically. Suffix changed from .sql.gz to .sql.gz.gpg — the grep
  # matches the new suffix; pre-existing un-encrypted backups (if any)
  # remain in the bucket and must be pruned manually after a transition.
  existing=$(aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" 2>/dev/null \
    | awk '{print $4}' | grep -E '\.sql\.gz\.gpg$' | sort -r || true)
  if [ -n "$existing" ]; then
    echo "$existing" | tail -n +$((BACKUP_RETENTION_COUNT + 1)) | while IFS= read -r old; do
      [ -n "$old" ] || continue
      echo "[backup] Pruning s3://${S3_BUCKET}/${S3_PREFIX}/${old}"
      aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/${old}" --no-progress || true
    done
  fi
  return "$status"
}

echo "[backup] Started — interval ${BACKUP_INTERVAL_SECONDS}s, retention ${BACKUP_RETENTION_COUNT}, target s3://${S3_BUCKET}/${S3_PREFIX}/ (gpg AES256, SSE-S3)"

# Run once at startup so a fresh deploy already has a snapshot.
first_status=0
backup_once || first_status=1

# `--once` mode: used by the belt-and-braces host cron (roles/backup_cron),
# which `docker compose exec`s this script inside the running sidecar for
# a one-shot run. Without this exit, the exec'd invocation would fall
# into the interval loop below and never return — the cron job would hang
# forever and stack a new orphaned loop process every night.
if [ "${1:-}" = "--once" ]; then
  if [ "$first_status" -ne 0 ]; then
    echo "[backup] --once: backup FAILED, exiting non-zero." >&2
    exit 1
  fi
  echo "[backup] --once: single run complete, exiting."
  exit 0
fi

while true; do
  sleep "$BACKUP_INTERVAL_SECONDS"
  backup_once || echo "[backup] run failed; retrying in ${BACKUP_INTERVAL_SECONDS}s" >&2
done
