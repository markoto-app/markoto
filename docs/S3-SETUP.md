# S3 Bucket Setup

YPad uses external S3 in production (Infomaniak by default; any S3-compatible endpoint works via `NUXT_S3_ENDPOINT`). Browsers talk to the bucket **directly** for image uploads (presigned PUT) and image reads (302-redirect to presigned GET from `/api/files/:docId/:fileId`). Traefik never proxies S3 traffic in prod — so CORS must be configured on the bucket itself.

## 1. Create the bucket

Whatever you set in `S3_BUCKET`. Region doesn't matter to the app.

Object layout (app-managed, don't pre-create):

```
docs/{docId}/{fileId}.{ext}          # image uploads
backups/postgres/{ISO8601}.sql.gz    # daily pg_dump
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

Replace `${DOMAIN}` literally (e.g. `https://ypad.example.com`). No trailing slash. No wildcards — presigned URLs carry SigV4 auth in the querystring so broad CORS isn't needed.

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

## 5. What NOT to do

- Don't proxy S3 through Traefik in prod — it doubles egress and defeats the point of presigned URLs. The dev setup uses `devProxy` in `nuxt.config.ts` only to work around SeaweedFS's stricter-than-AWS CORS behaviour locally.
- Don't allow `*` as `AllowedOrigins`. Presigned URLs are short-lived but still credential-bearing; a leaked URL + permissive CORS = cross-origin exfil window.
- Don't omit `ExposeHeaders: ETag` — the SDK's multipart-upload path reads it and silently fails without it.
