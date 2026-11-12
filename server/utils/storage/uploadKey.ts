// Shape of the S3 keys minted by `POST /api/upload/request`:
//   docs/{docId}/{fileId}.{ext}           final key (uploads.s3_key, served by /api/files)
//   docs/{docId}/staging/{fileId}.{ext}   staging key (the only key the presigned PUT can write)
// `confirm` must never act on a key that doesn't match this shape, the
// bucket also holds backups, renders, knowledge originals and exports.
//
// Why two keys: a presigned PUT stays usable for its whole lifetime, also
// after confirm. Confirm copies the staging object to the final key and
// sniffs the COPY, so re-using the URL afterwards only rewrites the
// staging key (reaped by orphan-cleanup), never the confirmed image.

// nanoid alphabet + a generous length window. Any docId that doesn't match
// is rejected before being interpolated into an S3 key.
export const DOC_ID_RE = /^[A-Za-z0-9_-]{8,32}$/

// `fileId` is `nanoid(12)`; the extensions are the values of
// CONTENT_TYPE_EXT in request.post.ts.
const UPLOAD_KEY_RE = /^docs\/([A-Za-z0-9_-]{8,32})\/([A-Za-z0-9_-]{12})\.(png|jpg|gif|webp)$/

export interface ParsedUploadKey {
  docId: string
  /** `{nanoid}.{ext}`: the value stored in `uploads.file_id`. */
  fileId: string
  ext: string
}

export function buildUploadKey(docId: string, fileId: string, ext: string): string {
  return `docs/${docId}/${fileId}.${ext}`
}

/**
 * Staging key for a final upload key (`docs/{docId}/{file}` →
 * `docs/{docId}/staging/{file}`). `/api/files` can't reach it: its
 * fileId segment allows no `/`.
 */
export function stagingKeyFor(finalKey: string): string {
  const slash = finalKey.lastIndexOf('/')
  return `${finalKey.slice(0, slash)}/staging${finalKey.slice(slash)}`
}

/** Returns null unless `key` is exactly a key `/api/upload/request` could have issued. */
export function parseUploadKey(key: unknown): ParsedUploadKey | null {
  if (typeof key !== 'string') return null
  const m = UPLOAD_KEY_RE.exec(key)
  if (!m) return null
  const [, docId, id, ext] = m
  if (!docId || !id || !ext) return null
  return { docId, fileId: `${id}.${ext}`, ext }
}
