# S3 bucket setup

How to prepare an external S3-compatible bucket for markoto. The self-host stack ships SeaweedFS and needs none of this; use this guide when you point `NUXT_S3_ENDPOINT` at an external provider instead (see [SELF-HOSTING.md](SELF-HOSTING.md#storage)). The hosted service uses OVH Object Storage.

Browsers talk to the bucket **directly**: image and knowledge uploads use presigned PUT URLs, and image reads, PDF downloads and data-export downloads redirect to presigned GET URLs. The app never proxies that traffic, so CORS must be configured on the bucket itself.

The `aws s3api` commands below work against any S3-compatible endpoint (`--endpoint-url`). Many provider consoles do not expose CORS, lifecycle or default-encryption settings; the S3 API does.

## 1. Create the bucket

Any name; set it as `NUXT_S3_BUCKET`. The region does not matter to the app.

Keep the bucket **private**: no public-read ACL, no bucket policy that grants anonymous `s3:GetObject` or `s3:ListBucket`. Every object the app hands out goes through a short-lived presigned URL, so nothing needs public access. A bucket that allows public listing lets anyone enumerate keys. Check it after setup:

```bash
aws s3api get-bucket-acl    --endpoint-url "$NUXT_S3_ENDPOINT" --bucket "$NUXT_S3_BUCKET"
aws s3api get-bucket-policy --endpoint-url "$NUXT_S3_ENDPOINT" --bucket "$NUXT_S3_BUCKET"   # expect: no policy, or none granting "*"
```

Object layout (created by the app; don't pre-create anything):

```
docs/{docId}/{fileId}.{ext}                       # document images
docs/{docId}/staging/{fileId}.{ext}               # upload target of a presigned PUT, copied to the final key on confirm
workspaces/{wsId}/knowledge/{kId}.{ext}           # knowledge originals, deleted after processing
workspaces/{wsId}/brand/{id}.{ext}                # workspace brand-kit fonts and logos
design-imports/{userId}/staging/{id}.{ext}        # files for "create a design from a document", transient
renders/{docId}/{snapshotId}[-{variant}]/…        # cached PDF, page PNGs and manifest.json
published/{pageId}/…                              # images and fonts of published pages
exports/{userId}/{jobId}.zip                      # data exports, 7-day download window
backups/postgres/{timestamp}.sql.gz.gpg           # encrypted database dumps (prefix: BACKUP_S3_PREFIX)
```

## 2. Create an access key scoped to the bucket

Set `NUXT_S3_ACCESS_KEY` and `NUXT_S3_SECRET_KEY`. The key needs, and should get, nothing more than:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `<bucket>/*` (HEAD and server-side copy are covered by these)
- `s3:ListBucket` on `<bucket>` (used by the storage clean-up sweeps and the backup retention prune)

No bucket-level create or delete permissions. The backup service can use a separate bucket and key (`BACKUP_S3_*`, see [SELF-HOSTING.md](SELF-HOSTING.md#backups)); then the app's key needs no access to the backups.

## 3. CORS policy (required)

Browsers PUT uploads to presigned URLs on the bucket host. Without CORS the preflight fails and uploads never start. Apply:

```json
[
  {
    "AllowedOrigins": ["https://docs.example.org"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Use your instance's public URL as the origin, without trailing slash and without wildcards. Presigned URLs carry their signature in the query string, so a broad CORS policy is not needed.

```bash
aws s3api put-bucket-cors \
  --endpoint-url "$NUXT_S3_ENDPOINT" \
  --bucket "$NUXT_S3_BUCKET" \
  --cors-configuration file://cors.json
```

where `cors.json` wraps the rules above in `{ "CORSRules": [ ... ] }`.

## 4. Verify CORS

From the browser devtools console on your instance:

```js
fetch('https://<bucket-host>/<any-key>', { method: 'HEAD' })
  .then(r => console.log(r.headers.get('access-control-allow-origin')))
```

It should log your origin. `null` or a CORS error means the policy did not apply.

## 5. Lifecycle policy (recommended)

Renders under `renders/` are a cache: the app recreates them on demand and removes a document's renders when the document is deleted, but each document change produces a new snapshot folder and the old ones are never read again. An expiration rule keeps the bucket from growing. Data exports under `exports/` are deleted by the app after their 7-day window; a rule is the safety net if that deletion fails.

```bash
cat > lifecycle.json <<'EOF'
{
  "Rules": [
    { "ID": "expire-renders-30d", "Status": "Enabled", "Filter": { "Prefix": "renders/" }, "Expiration": { "Days": 30 } },
    { "ID": "expire-exports-8d",  "Status": "Enabled", "Filter": { "Prefix": "exports/" }, "Expiration": { "Days": 8 } }
  ]
}
EOF

aws s3api put-bucket-lifecycle-configuration \
  --endpoint-url "$NUXT_S3_ENDPOINT" \
  --bucket "$NUXT_S3_BUCKET" \
  --lifecycle-configuration file://lifecycle.json

aws s3api get-bucket-lifecycle-configuration --endpoint-url "$NUXT_S3_ENDPOINT" --bucket "$NUXT_S3_BUCKET"
```

Never add `docs/`, `workspaces/`, `published/` or `backups/` to an expiration rule: those are not cache. Old backups are pruned by the backup service (`BACKUP_RETENTION_COUNT`).

## 6. Default encryption (required)

Every object should be stored server-side encrypted (SSE-S3, AES-256, provider-managed key). Browser uploads go through presigned PUTs that do **not** carry an `x-amz-server-side-encryption` header (signing it into the URL would force the browser to send it exactly), and the app's own uploads (AI-generated images, brand assets, exports) don't set it either. The bucket's default encryption is what encrypts those.

The renderer (PDF and page images) and the backup service also set the header on each object. Both read `S3_SSE` (default `AES256`); set `S3_SSE=none` on those two services only if your provider rejects the header.

```bash
cat > encryption.json <<'EOF'
{
  "Rules": [
    { "ApplyServerSideEncryptionByDefault": { "SSEAlgorithm": "AES256" }, "BucketKeyEnabled": true }
  ]
}
EOF

aws s3api put-bucket-encryption \
  --endpoint-url "$NUXT_S3_ENDPOINT" \
  --bucket "$NUXT_S3_BUCKET" \
  --server-side-encryption-configuration file://encryption.json

aws s3api get-bucket-encryption --endpoint-url "$NUXT_S3_ENDPOINT" --bucket "$NUXT_S3_BUCKET"
# Expect: SSEAlgorithm = AES256
```

To confirm on a real object, run `aws s3api head-object` on any recent key and look for `ServerSideEncryption: AES256`.

What SSE-S3 does and does not protect:

- The provider holds the key. It protects against physical-disk theft and other tenants, not against a leaked access key (the provider decrypts for any signed request), a bucket made public by mistake, or the provider itself.
- Database backups get a client-side layer on top: the backup service encrypts each dump with gpg (AES-256, `BACKUP_GPG_PASSPHRASE`) before upload, so the bucket alone is not enough to read them.
- Images, knowledge originals and renders rely on SSE-S3 alone; a leaked access key exposes them.

## 7. What not to do

- Don't allow `*` in `AllowedOrigins`. Presigned URLs are short-lived but still carry credentials; a leaked URL plus permissive CORS lets any site read it.
- Don't make the bucket or any prefix public (section 1).
- Don't omit `ExposeHeaders: ETag` from the CORS rule.
- Don't share the access key with other applications; give markoto a key limited to its bucket (section 2).
