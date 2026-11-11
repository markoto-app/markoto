import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { ID_PATTERN } from '~~/shared/config/identifiers'
import { ownValue } from '~~/shared/utils/ownValue'

// fileId is a nanoid(12) with a content-type-derived extension. Not a security
// boundary (S3 keys are opaque); it just stops malformed clients from presigning
// nonsense keys.
const FILE_ID_RE = new RegExp(`^${ID_PATTERN}\\.(png|jpg|jpeg|gif|webp)$`)

const EXT_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

// Anonymous callers too (images in anonymously shared docs): `decideFileAccess`
// lets anyone read on open-* docs, and on private / password-protected ones
// the owner, workspace members and holders of a document JWT — including the
// `file-access` tokens of the render page and the live preview iframe, which
// have no session cookie. A deleted doc is 404 even if its S3 objects outlived
// best-effort cleanup.
export default defineApiHandler({
  access: allow.doc('file', { anonymous: true, jwt: ['file-access'], deny: 'files/access-denied' }),
  params: z.object({ docId: z.string().min(1), fileId: z.string().regex(FILE_ID_RE) }),
  handler: async ({ event, docId, params: { fileId } }) => {
    const s3 = usePresignS3Client()
    const config = useRuntimeConfig()
    const key = `docs/${docId}/${fileId}`

    // Short TTL because a presigned URL can't be revoked: it outlives a deletion,
    // access-mode change or password rotation. 120s is enough to follow the 302.
    //
    // The response type is forced from the file extension (`response-content-type`)
    // rather than the stored type: an image URL must never be served as HTML,
    // even for objects uploaded before the type was bound at upload.
    const ext = fileId.slice(fileId.lastIndexOf('.') + 1).toLowerCase()
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        ResponseContentType: ownValue(EXT_CONTENT_TYPE, ext) ?? 'application/octet-stream',
        ResponseContentDisposition: `inline; filename="${fileId}"`
      }),
      { expiresIn: 120 }
    )

    return sendPrivateRedirect(event, url)
  }
})
