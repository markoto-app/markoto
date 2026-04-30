import { HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { markConfirmed } from '../../repos/uploads'
import { requireContentMatchesExtension } from '../../utils/fileTypeGuard'

// Mirrors `CONTENT_TYPE_EXT` in request.post.ts. The key is shaped
// `docs/{docId}/{fileId}.{ext}` — the ext is the source of truth for
// what the bytes are SUPPOSED to be, the magic-byte sniff verifies
// what they ACTUALLY are.
const KEY_EXT_RE = /\.([a-z0-9]+)$/i

export default defineEventHandler(async (event) => {
  const { key } = await readBody(event)

  if (!key) {
    throw createError({ statusCode: 400, message: 'Missing key' })
  }

  const s3 = useS3Client()
  const config = useRuntimeConfig()

  let head
  try {
    head = await s3.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }))
  } catch {
    throw createError({ statusCode: 404, message: 'Upload not found in S3' })
  }

  // Magic-byte sniff. The presigned PUT only binds the Content-Type
  // header that S3 records — not the actual bytes. Without this gate,
  // a client can sign as `image/png` and upload SVG-with-script (or
  // any other binary). On mismatch we 415 AND delete the orphan so a
  // probing attacker can't fill the bucket with garbage. The exception
  // is anonymous-doc edge case (no DB row) — markConfirmed silently
  // no-ops there but the S3 delete still runs.
  const extMatch = KEY_EXT_RE.exec(key)
  const ext = extMatch?.[1]?.toLowerCase()
  if (!ext) {
    throw createError({ statusCode: 400, message: 'Upload key missing file extension' })
  }
  try {
    await requireContentMatchesExtension({ s3Key: key, ext })
  } catch (e) {
    // Best-effort orphan delete on rejection. We swallow secondary
    // errors here — the caller already gets a meaningful 415/500 and
    // the orphan-cleanup sweeper will reap stragglers within 24h.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }))
    } catch { /* sweeper covers it */ }
    throw e
  }

  // Flip the matching uploads row to confirmed. We don't fail if the row is
  // missing (anonymous-doc upload path doesn't create a row) — the HEAD
  // check above is the real "did it land in S3" gate.
  await markConfirmed(key)

  return {
    success: true,
    size: head.ContentLength,
    contentType: head.ContentType
  }
})
