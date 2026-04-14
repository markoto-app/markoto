#!/bin/sh
# Periodic Postgres → S3 backup. Pipes pg_dump through gzip and uploads to
# s3://$S3_BUCKET/backups/postgres/{timestamp}.sql.gz, then prunes anything
# beyond BACKUP_RETENTION_COUNT newest backups.
#
# Same script works against any S3-compatible endpoint (SeaweedFS in dev,
# Infomaniak / R2 / AWS in prod) — only env changes.
#
# Restore: download the file, gunzip, and `psql $DATABASE_URL < dump.sql`.
# The dump uses --clean --if-exists so it drops existing objects before recreating.

set -e

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

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"

backup_once() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  key="backups/postgres/${ts}.sql.gz"
  tmp="/tmp/${ts}.sql.gz"

  echo "[backup] $(date -u +%FT%TZ) Starting pg_dump → s3://${S3_BUCKET}/${key}"
  if pg_dump -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --no-owner --clean --if-exists 2>/tmp/pg_dump.err | gzip > "$tmp"; then
    size=$(du -h "$tmp" | cut -f1)
    if aws --endpoint-url "$S3_ENDPOINT" s3 cp "$tmp" "s3://${S3_BUCKET}/${key}" --no-progress; then
      echo "[backup] Uploaded ${size} to s3://${S3_BUCKET}/${key}"
    else
      echo "[backup] S3 upload FAILED for ${key}" >&2
    fi
  else
    echo "[backup] pg_dump FAILED:" >&2
    cat /tmp/pg_dump.err >&2
  fi
  rm -f "$tmp" /tmp/pg_dump.err

  # Retention: keep newest N, drop the rest. ISO-8601-ish timestamps sort lexically.
  existing=$(aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://${S3_BUCKET}/backups/postgres/" 2>/dev/null \
    | awk '{print $4}' | grep -E '\.sql\.gz$' | sort -r || true)
  if [ -n "$existing" ]; then
    echo "$existing" | tail -n +$((BACKUP_RETENTION_COUNT + 1)) | while IFS= read -r old; do
      [ -n "$old" ] || continue
      echo "[backup] Pruning s3://${S3_BUCKET}/backups/postgres/${old}"
      aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://${S3_BUCKET}/backups/postgres/${old}" --no-progress || true
    done
  fi
}

echo "[backup] Started — interval ${BACKUP_INTERVAL_SECONDS}s, retention ${BACKUP_RETENTION_COUNT}, target s3://${S3_BUCKET}/backups/postgres/"

# Run once at startup so a fresh deploy already has a snapshot.
backup_once

while true; do
  sleep "$BACKUP_INTERVAL_SECONDS"
  backup_once
done
