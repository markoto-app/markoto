import { PutObjectCommand } from '@aws-sdk/client-s3'
import { fileTypeFromBuffer } from 'file-type'
import { nanoid } from 'nanoid'
import { deletePending, markConfirmed, reservePendingUpload } from '../../repos/uploads'
import type { DocAccess, UserScope } from '../../repos/proofs'
import { resolveImageQuota, type ImageQuota } from '../storage/imageQuota'
import { useEnv } from '~~/shared/env/load'
import { IMAGE_UPLOAD_MAX_BYTES } from '~~/shared/config/uploads'
import { collectMarkdownRefs, decodeImageDataUri, rewriteMarkdownRefs } from './markdownRefs'

// Images of an imported document stored as the document's own uploads (the
// same rows, keys and quota as images a user drops into the editor): pictures
// embedded in a converted file (`data:` URIs from markitdown) and images a
// Markdown file links to by relative path. Only PNG, JPEG, GIF and WebP,
// recognised by their bytes (never by name), at most 10 MB each, within the
// importer's image quota. An image that can't be stored is left as written
// (a data URI is replaced by its alt text) and counted.

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export type ImageStoreResult = { url: string } | { skipped: 'too-large' | 'unsupported' | 'quota' | 'failed' }

/** Store one image under the document. */
export async function storeImportedImage(doc: DocAccess<'write'>, uploader: UserScope, bytes: Uint8Array, quota: ImageQuota): Promise<ImageStoreResult> {
  if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_UPLOAD_MAX_BYTES) return { skipped: 'too-large' }
  const type = await fileTypeFromBuffer(bytes)
  const ext = type ? MIME_EXT[type.mime] : undefined
  if (!type || !ext) return { skipped: 'unsupported' }
  const fileId = `${nanoid(12)}.${ext}`
  const key = `docs/${doc.docId}/${fileId}`
  const reservation = await reservePendingUpload(doc, {
    fileId,
    uploaderId: uploader.userId,
    contentType: type.mime,
    sizeBytes: bytes.byteLength,
    s3Key: key
  }, quota.maxBytes, quota.scope)
  if (!reservation.reserved) return { skipped: 'quota' }
  try {
    const env = useEnv()
    await useS3Client().send(new PutObjectCommand({
      Bucket: env.storage.bucket,
      Key: key,
      Body: bytes,
      ContentType: type.mime,
      ContentLength: bytes.byteLength
    }))
    // Written by the server, never through a presigned URL: no staging copy.
    await markConfirmed(doc, key)
  } catch {
    await deletePending(uploader, key).catch(() => { /* reaped by orphan-cleanup */ })
    return { skipped: 'failed' }
  }
  return { url: `/api/files/${doc.docId}/${fileId}` }
}

function isRemote(target: string): boolean {
  return target.startsWith('//') || /^[a-z][a-z0-9+.-]{0,20}:/i.test(target)
}

/**
 * Store the images of `markdown` and point its references at them. `readLinked`
 * returns the bytes of a relative image target (null: not part of the import).
 * `links` maps other link targets (imported documents). Returns the rewritten
 * Markdown and how many images could not be stored.
 */
export async function attachImportImages(args: {
  doc: DocAccess<'write'>
  uploader: UserScope
  markdown: string
  readLinked: (target: string) => Promise<Uint8Array | null>
  links?: ReadonlyMap<string, string>
}): Promise<{ markdown: string, imagesStored: number, imagesSkipped: number }> {
  const refs = collectMarkdownRefs(args.markdown)
  const images = new Map<string, string>()
  let stored = 0
  let skipped = 0
  let quota: ImageQuota | null = null
  for (const target of refs.images) {
    const isData = target.startsWith('data:')
    const bytes = isData ? decodeImageDataUri(target)?.bytes ?? null : await args.readLinked(target)
    let url: string | null = null
    if (bytes) {
      quota ??= await resolveImageQuota(args.uploader.userId, args.doc.docId)
      const result = await storeImportedImage(args.doc, args.uploader, bytes, quota)
      if ('url' in result) url = result.url
    }
    if (url !== null) {
      images.set(target, url)
      stored++
      continue
    }
    // A data URI that couldn't be stored is dropped rather than kept as
    // megabytes of base64 text; a remote URL stays as written.
    if (isData) images.set(target, '#')
    if (isData || bytes || !isRemote(target)) skipped++
  }
  return {
    markdown: rewriteMarkdownRefs(args.markdown, images, args.links ?? new Map()),
    imagesStored: stored,
    imagesSkipped: skipped
  }
}
