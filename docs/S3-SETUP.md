# S3 Bucket Setup

markoto uses external S3 in production (Infomaniak by default; any S3-compatible endpoint works via `NUXT_S3_ENDPOINT`). Browsers talk to the bucket **directly** for image uploads (presigned PUT) and image reads (302-redirect to presigned GET from `/api/files/:docId/:fileId`). Traefik never proxies S3 traffic in prod — so CORS must be configured on the bucket itself.

## 1. Create the bucket

Whatever you set in `S3_BUCKET`. Region doesn't matter to the app.

Object layout (app-managed, don't pre-create):

```
docs/{docId}/{fileId}.{ext}                            # image uploads
workspaces/{wsId}/knowledge/{kId}.{ext}                # transient — deleted after processing
renders/{docId}/{snapshotId}/document.pdf              # PDF renders (cached)
renders/{docId}/{snapshotId}/page-{n}.png              # per-page screenshots (cached)
renders/{docId}/{snapshotId}/manifest.json             # render readiness sentinel
backups/postgres/{ISO8601}.sql.gz                      # daily pg_dump
```

## 2. Create an access key scoped to the bucket

Set `S3_ACCESS_KEY` and `S3_SECRET_KEY` in `.env`. The key needs:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:HeadObject` on `${S3_BUCKET}/*`
- `s3:ListBucket` on `${S3_BUCKET}` (used by the orphan-cleanup plugin and the backup retention prune)

No bucket-level create/delete permissions required.

## 3. CORS policy — required

Browsers PUT images directly to presigned URLs on the bucket host. Without CORS, the preflight fails and uploads never start. Apply this policy:

```json
[
  {
    "AllowedOrigins": ["https://${DOMAIN}"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Replace `${DOMAIN}` literally (e.g. `https://markoto.example.com`). No trailing slash. No wildcards — presigned URLs carry SigV4 auth in the querystring so broad CORS isn't needed.

### Infomaniak

Dashboard → Public Cloud → Object Storage → your bucket → *Settings / CORS* → paste the policy.

### AWS / R2 / MinIO

```bash
aws s3api put-bucket-cors \
  --endpoint-url "${S3_ENDPOINT}" \
  --bucket "${S3_BUCKET}" \
  --cors-configuration file://cors.json
```

where `cors.json` wraps the rules above in `{ "CORSRules": [ ... ] }`.

## 4. Verify

From a browser devtools console on `https://${DOMAIN}`:

```js
fetch('https://<bucket-host>/<any-key>', { method: 'HEAD' })
  .then(r => console.log(r.headers.get('access-control-allow-origin')))
```

Should log your domain. If it logs `null` or CORS-errors, the policy didn't stick.

## 5. Lifecycle policy — recommended

Renders under `renders/` are CACHE artefacts. The app re-creates them on demand and `deleteDocument` cleans up per-doc renders eagerly, but bucket-side expiration is the safety net for orphaned snapshots (the snapshotId in the key changes on every Y.Doc update — old snapshots are unreachable but linger). Set up a 30-day expiration so the bucket doesn't grow unbounded.

### Infomaniak

The dashboard does NOT expose lifecycle rules. Use the S3 API directly (Infomaniak supports the standard `PutBucketLifecycleConfiguration` call).

### AWS / R2 / MinIO / Infomaniak (S3 API)

```bash
cat > lifecycle.json <<'EOF'
{
  "Rules": [
    {
      "ID": "expire-renders-30d",
      "Status": "Enabled",
      "Filter": { "Prefix": "renders/" },
      "Expiration": { "Days": 30 }
    }
  ]
}
EOF

aws s3api put-bucket-lifecycle-configuration \
  --endpoint-url "${S3_ENDPOINT}" \
  --bucket "${S3_BUCKET}" \
  --lifecycle-configuration file://lifecycle.json
```

Verify:

```bash
aws s3api get-bucket-lifecycle-configuration \
  --endpoint-url "${S3_ENDPOINT}" \
  --bucket "${S3_BUCKET}"
```

A user re-downloading a 31-day-old PDF triggers a fresh render — wasteful but rare. Keep the rule scoped to `renders/` only; image uploads under `docs/` and pg backups under `backups/` are not cache, do NOT add them to the rule.

## 6. What NOT to do

- Don't proxy S3 through Traefik in prod — it doubles egress and defeats the point of presigned URLs. The dev setup uses `devProxy` in `nuxt.config.ts` only to work around SeaweedFS's stricter-than-AWS CORS behaviour locally.
- Don't allow `*` as `AllowedOrigins`. Presigned URLs are short-lived but still credential-bearing; a leaked URL + permissive CORS = cross-origin exfil window.
- Don't omit `ExposeHeaders: ETag` — the SDK's multipart-upload path reads it and silently fails without it.
