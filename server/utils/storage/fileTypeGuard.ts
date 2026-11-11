import { GetObjectCommand } from '@aws-sdk/client-s3'
import { fileTypeFromBuffer } from 'file-type'
import { ownValue } from '~~/shared/utils/ownValue'

/**
 * Content-type guard run at confirm time, BEFORE the DB row is
 * created. Stops the obvious abuse where a client signs a presigned
 * URL as `application/pdf`, then PUTs actual `.exe` bytes — the signed
 * `Content-Type` binds what S3 records on the object, not what the
 * bytes actually are. Without this, the row lands in S3 + DB, the
 * processor fails when markitdown can't parse it, and we've still
 * burned the user's byte quota on junk.
 *
 * Strategy:
 *   - For binary formats with reliable magic bytes (pdf / docx / pptx /
 *     xlsx / epub) use the `file-type` library, which sniffs ~30 bytes
 *     and returns the real MIME. We fetch JUST those first bytes via
 *     an S3 Range GET — cheap regardless of file size.
 *   - For plain text (md / txt / html) there's no reliable signature,
 *     so we fetch the first 1 KB and do a printable-UTF-8 ratio check.
 *     Not as tight as magic bytes, but rejects bytes that aren't even
 *     plausibly text (e.g. random binary renamed to .txt).
 *
 * Fails closed: if the probe itself fails (S3 unreachable, byte range
 * read fails), throws a 500 — we'd rather error loudly than silently
 * accept unvalidated content.
 */

// Covers DOCX, PPTX, XLSX — they're all ZIP containers. `file-type`
// inspects `[Content_Types].xml` inside the ZIP to differentiate them,
// so a DOCX renamed as .xlsx is still caught.
const EXT_TO_ALLOWED_MIMES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  // .xls (legacy Office) is a CFB file — sniffed as `application/x-cfb`
  // by file-type. We allow both Office and CFB to accommodate older files.
  xls: ['application/vnd.ms-excel', 'application/x-cfb'],
  epub: ['application/epub+zip'],
  // Image extensions for the doc-asset upload path (`/api/upload/*`).
  // Without this, a presigned URL minted as `Content-Type: image/png`
  // can be PUT with arbitrary bytes (SVG-with-script, an .exe renamed
  // to .png). file-type's magic-byte detection cleanly differentiates
  // each format — even animated WebP and GIF have stable signatures.
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp']
}

// Text formats with no reliable magic byte. We skip the library probe
// and do a printable-ratio check instead.
const TEXT_EXTS = new Set(['md', 'txt', 'html', 'htm'])

// Read budget for the printable-ratio check. 1 KB is plenty to catch
// "random binary renamed as .txt" while being too small for a real
// attacker to pad the header with legit-looking text.
const TEXT_PROBE_BYTES = 1024

// Threshold for the printable-ratio check. UTF-8 text is normally
// close to 100% printable; even code with control whitespace stays
// above 98%. A binary renamed as .txt has a printable ratio near 30%.
const TEXT_PRINTABLE_THRESHOLD = 0.9

async function fetchBytes(bucket: string, key: string, rangeEnd: number): Promise<Uint8Array> {
  const s3 = useS3Client()
  const resp = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    Range: `bytes=0-${rangeEnd}`
  }))
  return await resp.Body!.transformToByteArray()
}

function isPrintableUtf8(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  let printable = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    // Tab, newline, carriage return, anything \x20+ that isn't a delete
    // control, and all non-ASCII (covers Unicode content).
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) {
      printable += 1
    }
  }
  return printable / text.length >= TEXT_PRINTABLE_THRESHOLD
}

/**
 * Throws `createError(415)` on mismatch; resolves silently on match.
 * Signature matches the `require*` utility pattern used elsewhere in
 * server/utils/.
 */
export async function requireContentMatchesExtension(args: {
  s3Key: string
  ext: string
}): Promise<void> {
  const config = useRuntimeConfig()
  const ext = args.ext.toLowerCase()

  if (TEXT_EXTS.has(ext)) {
    // Text formats have no reliable magic — verify "plausibly text" via
    // printable-UTF-8 ratio on the first 1 KB.
    let bytes: Uint8Array
    try {
      bytes = await fetchBytes(config.s3.bucket, args.s3Key, TEXT_PROBE_BYTES - 1)
    } catch (e) {
      throw createError({ statusCode: 500, message: `Could not read uploaded object: ${e instanceof Error ? e.message : 'unknown'}` })
    }
    if (!isPrintableUtf8(bytes)) {
      throw createError({
        statusCode: 415,
        message: `Uploaded .${ext} file doesn't look like text. Rename it if you meant to upload a binary format.`
      })
    }
    return
  }

  const allowed = ownValue(EXT_TO_ALLOWED_MIMES, ext)
  if (!allowed) {
    throw createError({ statusCode: 415, message: `Unsupported extension: .${ext}` })
  }

  // file-type's sniffers peek at most a few dozen bytes; 32 is enough
  // for PDF, and for the ZIP-container Office formats the library
  // seeks further inside the ZIP on its own (it needs more bytes for
  // that, so we give it a generous head).
  let bytes: Uint8Array
  try {
    bytes = await fetchBytes(config.s3.bucket, args.s3Key, 4095)
  } catch (e) {
    throw createError({ statusCode: 500, message: `Could not read uploaded object: ${e instanceof Error ? e.message : 'unknown'}` })
  }

  const detected = await fileTypeFromBuffer(bytes)
  if (!detected) {
    throw createError({
      statusCode: 415,
      message: `Could not determine content type of uploaded .${ext} file. The bytes don't match the claimed format.`
    })
  }
  if (!allowed.includes(detected.mime)) {
    throw createError({
      statusCode: 415,
      message: `Uploaded .${ext} file has content type ${detected.mime}; expected one of ${allowed.join(', ')}. Rename the file to match its actual format.`
    })
  }
}

/**
 * In-memory variant for uploads the server reads whole anyway (the
 * design-import file): sniffs the SAME bytes that get processed, so a
 * re-used presigned URL can't swap them between check and read.
 * Binary formats only.
 */
export async function bytesMatchExtension(bytes: Uint8Array, ext: string): Promise<boolean> {
  const allowed = ownValue(EXT_TO_ALLOWED_MIMES, ext.toLowerCase())
  if (!allowed) return false
  const detected = await fileTypeFromBuffer(bytes)
  return detected !== undefined && allowed.includes(detected.mime)
}
