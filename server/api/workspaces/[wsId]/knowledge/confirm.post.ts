import { CopyObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { createKnowledge, disambiguateFilename } from '../../../../repos/knowledge'
import { useDatabase } from '../../../../utils/platform/database'
import { resolveEmbeddingsConfig, embeddingVersionTag } from '../../../../utils/knowledge/embeddings'
import { processKnowledge } from '../../../../utils/knowledge/processKnowledge'
import { requireContentMatchesExtension } from '../../../../utils/storage/fileTypeGuard'
import { assertCapsOnConfirm, releaseKnowledgeUploadSlots } from '../../../../utils/knowledge/knowledgeQuota'
import { claimPendingKnowledgeUpload, restorePendingKnowledgeUpload } from '../../../../utils/knowledge/knowledgePendingUpload'
import { stagingKeyFor } from '../../../../utils/storage/uploadKey'
import { confirmKnowledgeUploadBody } from '~~/shared/api/workspaces'
import { useEnv } from '~~/shared/env/load'

/** The original's stored Content-Type must be exactly the type upload-request signed. */
function requireStoredContentType(stored: string | undefined, expected: string): void {
  const normalised = stored?.split(';')[0]?.trim().toLowerCase()
  if (normalised !== expected.toLowerCase()) {
    throw apiError('knowledge/content-type-mismatch')
  }
}

/**
 * Step 2: after the client has PUT the file to S3, call this to:
 *   0. Claim the pending record upload-request issued to this caller for
 *      this workspace (404 otherwise — no S3 call).
 *   1. HEAD the staging object (did it actually land? stored type = the
 *      signed type?).
 *   2. Copy it to the final key, delete the staging key, and sniff the
 *      COPY's first bytes — confirm the content matches the claimed
 *      extension (stops the "signed as PDF, uploaded EXE" abuse, and a
 *      re-used presigned URL can't swap the bytes after the sniff).
 *   3. Take a Postgres advisory lock keyed on the workspace ID,
 *      re-check all caps, disambiguate filename, and insert the row —
 *      all inside one transaction. The lock serialises concurrent
 *      confirms for the same workspace so a pair of uploads that both
 *      squeaked past upload-request can't both overshoot the cap.
 *   4. Release the Valkey inflight slots this upload reserved.
 *   5. Kick off processing async — sweep-plugin rescues stuck rows.
 *
 * On ANY failure after step 1 we best-effort delete the S3 object —
 * otherwise unconfirmed-but-paid-for bytes would pile up if the user
 * hits a cap at confirm. Slot releases run in `finally` so they
 * always fire.
 */

const SAFE_KEY_RE = /^workspaces\/[A-Za-z0-9_-]+\/knowledge\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/

export default defineApiHandler({
  access: allow.workspace('editor', { deny: 'knowledge/editor-required' }),
  body: confirmKnowledgeUploadBody,
  handler: async ({ user, wsId, body }) => {
    const userId = user.id
    const { knowledgeId, s3Key, filename, ext, mimeType } = body
    if (!SAFE_KEY_RE.test(s3Key) || !s3Key.startsWith(`workspaces/${wsId}/knowledge/`)) {
      throw apiError('knowledge/invalid-key')
    }
    // Bind the knowledgeId to the s3Key tail. The client echoes back
    // BOTH values it got from upload-request; if they don't line up it
    // means either a confused client (unlikely) or a crafted request
    // trying to claim an arbitrary S3 object under a freshly-minted
    // knowledgeId. Stays out of trouble either way.
    const expectedTail = `/${knowledgeId}.${ext}`
    if (!s3Key.endsWith(expectedTail)) {
      throw apiError('knowledge/key-mismatch')
    }

    // The upload must be one `upload-request` issued to THIS caller in THIS
    // workspace (atomic claim — a replayed or foreign knowledgeId finds
    // nothing). Anything else is a 404 before any S3 call, so confirm can
    // never HEAD, adopt or delete an object it didn't hand to this caller.
    const pendingRef = { workspaceId: wsId, userId, knowledgeId }
    const pending = await claimPendingKnowledgeUpload(pendingRef)
    if (!pending || pending.s3Key !== s3Key || pending.ext !== ext || pending.mimeType !== mimeType) {
      throw apiError('knowledge/upload-not-found')
    }

    const env = useEnv()
    const s3 = useS3Client()
    // The browser PUT the staging key; the final key only ever holds the
    // copy confirm made (and sniffed) below.
    const stagingKey = stagingKeyFor(s3Key)

    const cleanupOrphanS3 = async () => {
      for (const Key of [stagingKey, s3Key]) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: env.storage.bucket, Key }))
        } catch { /* object may already be gone */ }
      }
    }

    try {
      let head
      try {
        head = await s3.send(new HeadObjectCommand({
          Bucket: env.storage.bucket,
          Key: stagingKey
        }))
      } catch {
        // Not landed (yet) — keep the claim so the client can retry.
        await restorePendingKnowledgeUpload(pendingRef, pending)
        throw apiError('knowledge/upload-not-found')
      }
      const sizeBytes = head.ContentLength ?? 0
      if (sizeBytes <= 0) {
        await cleanupOrphanS3()
        throw apiError('knowledge/empty-upload')
      }

      // Stored type (signed at upload-request) + copy to the final key +
      // magic-byte sniff OF THE COPY. Runs before caps so a junk upload
      // never consumes workspace bytes — we reject, delete, and release.
      // Bytes PUT to the staging key after the copy never reach the key
      // processKnowledge reads.
      try {
        requireStoredContentType(head.ContentType, mimeType)
        await s3.send(new CopyObjectCommand({
          Bucket: env.storage.bucket,
          CopySource: `/${env.storage.bucket}/${stagingKey}`,
          Key: s3Key,
          ContentType: mimeType,
          MetadataDirective: 'REPLACE'
        }))
        await s3.send(new DeleteObjectCommand({ Bucket: env.storage.bucket, Key: stagingKey }))
        await requireContentMatchesExtension({ s3Key, ext })
      } catch (e) {
        await cleanupOrphanS3()
        throw e
      }

      const embeddingVersion = embeddingVersionTag(resolveEmbeddingsConfig())
      const db = useDatabase()

      // Advisory lock + recheck + insert inside one transaction. The
      // hashtext() → bigint cast gives us a stable 64-bit key from the
      // workspace id. `pg_advisory_xact_lock` auto-releases at commit.
      let safeName: string
      try {
        safeName = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${wsId}))`)
          await assertCapsOnConfirm({ workspaceId: wsId, userId, size: sizeBytes })
          const name = await disambiguateFilename(wsId, filename)
          await createKnowledge({
            knowledgeId,
            workspaceId: wsId,
            filename: name,
            sourceExt: ext,
            mimeType,
            sizeBytes,
            s3Key,
            embeddingVersion,
            uploaderId: userId
          })
          return name
        })
      } catch (e) {
        await cleanupOrphanS3()
        throw e
      }

      // Fire-and-forget processing. Errors inside processKnowledge flip
      // the row to `failed` with an error message; the sweep plugin
      // catches anything orphaned by a crash.
      void processKnowledge(knowledgeId).catch((e) => {
        console.error(`[knowledge/confirm] background processKnowledge(${knowledgeId}) failed:`, e)
      })

      return {
        knowledgeId,
        filename: safeName,
        status: 'processing' as const
      }
    } finally {
      // Always release — success, cap rejection, content-type mismatch,
      // S3 missing, DB failure. The slot is a resource held during
      // upload; its life ends at confirm regardless of outcome.
      // Best-effort; rateLimit.ts swallows Valkey errors.
      await releaseKnowledgeUploadSlots(wsId, userId)
    }
  }
})
