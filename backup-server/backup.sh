#!/bin/sh
# Periodic Postgres → S3 backup. Pipes pg_dump through gzip + gpg
# (symmetric AES-256, passphrase from env) and uploads to
# s3://$S3_BUCKET/backups/postgres/{timestamp}.sql.gz.gpg, then prunes
# anything beyond BACKUP_RETENTION_COUNT newest backups.
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

set -e
# pipefail makes a pipeline return the FIRST non-zero exit, not just the
# last stage's. Without it, `pg_dump | gzip | gpg` reports success as long
# as gpg succeeds — even if pg_dump died mid-stream and produced a
# truncated dump. That's how a silently-corrupt backup gets uploaded and
# looks fine. Verified supported by busybox ash in postgres:16-alpine
# (the base image); it is NOT portable POSIX, so keep the alpine base.
set -o pipefail

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_USER:=ypad}"
: "${POSTGRES_DB:=ypad}"
: "${S3_BUCKET:=ypad}"
: "${BACKUP_INTERVAL_SECONDS:=86400}"   # 24 h
: "${BACKUP_RETENTION_COUNT:=30}"
: "${AWS_DEFAULT_REGION:=us-east-1}"
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

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"

backup_once() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  key="backups/postgres/${ts}.sql.gz.gpg"
  tmp="/tmp/${ts}.sql.gz.gpg"

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
    else
      size=$(du -h "$tmp" | cut -f1)
      # --sse AES256 is bucket-default-encryption defense-in-depth: even
      # though the file body is already gpg-encrypted, the S3 object's
      # at-rest layer adds the second key. Provider-managed key encrypts
      # ciphertext blob; passphrase decrypts the contents. Either alone
      # is insufficient for restore.
      if aws --endpoint-url "$S3_ENDPOINT" s3 cp "$tmp" "s3://${S3_BUCKET}/${key}" \
            --sse AES256 --no-progress; then
        echo "[backup] Uploaded ${size} (encrypted) to s3://${S3_BUCKET}/${key}"
      else
        echo "[backup] S3 upload FAILED for ${key}" >&2
      fi
    fi
  else
    echo "[backup] pg_dump | gpg pipeline FAILED:" >&2
    cat /tmp/pg_dump.err >&2
  fi
  rm -f "$tmp" /tmp/pg_dump.err

  # Retention: keep newest N, drop the rest. ISO-8601-ish timestamps sort
  # lexically. Suffix changed from .sql.gz to .sql.gz.gpg — the grep
  # matches the new suffix; pre-existing un-encrypted backups (if any)
  # remain in the bucket and must be pruned manually after a transition.
  existing=$(aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://${S3_BUCKET}/backups/postgres/" 2>/dev/null \
    | awk '{print $4}' | grep -E '\.sql\.gz\.gpg$' | sort -r || true)
  if [ -n "$existing" ]; then
    echo "$existing" | tail -n +$((BACKUP_RETENTION_COUNT + 1)) | while IFS= read -r old; do
      [ -n "$old" ] || continue
      echo "[backup] Pruning s3://${S3_BUCKET}/backups/postgres/${old}"
      aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://${S3_BUCKET}/backups/postgres/${old}" --no-progress || true
    done
  fi
}

echo "[backup] Started — interval ${BACKUP_INTERVAL_SECONDS}s, retention ${BACKUP_RETENTION_COUNT}, target s3://${S3_BUCKET}/backups/postgres/ (gpg AES256, SSE-S3)"

# Run once at startup so a fresh deploy already has a snapshot.
backup_once

# `--once` mode: used by the belt-and-braces host cron (roles/backup_cron),
# which `docker compose exec`s this script inside the running sidecar for
# a one-shot run. Without this exit, the exec'd invocation would fall
# into the interval loop below and never return — the cron job would hang
# forever and stack a new orphaned loop process every night.
if [ "${1:-}" = "--once" ]; then
  echo "[backup] --once: single run complete, exiting."
  exit 0
fi

while true; do
  sleep "$BACKUP_INTERVAL_SECONDS"
  backup_once
done
