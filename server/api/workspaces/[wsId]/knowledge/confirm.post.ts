import { HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { createKnowledge, disambiguateFilename } from '../../../../repos/knowledge'
import { useDatabase } from '../../../../utils/database'
import { resolveEmbeddingsConfig, embeddingVersionTag } from '../../../../utils/embeddings'
import { processKnowledge } from '../../../../utils/processKnowledge'
import { requireContentMatchesExtension } from '../../../../utils/fileTypeGuard'
import {
  assertCapsOnConfirm,
  INFLIGHT_NS_USER,
  INFLIGHT_NS_WORKSPACE
} from '../../../../utils/knowledgeQuota'
import { releaseInflightSlot } from '../../../../utils/rateLimit'
import { claimPendingKnowledgeUpload, restorePendingKnowledgeUpload } from '../../../../utils/knowledgePendingUpload'

/**
 * Step 2: after the client has PUT the file to S3, call this to:
 *   0. Claim the pending record upload-request issued to this caller for
 *      this workspace (404 otherwise — no S3 call).
 *   1. HEAD the object (did it actually land?).
 *   2. Sniff the first bytes — confirm the content matches the claimed
 *      extension (stops the "signed as PDF, uploaded EXE" abuse).
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

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const userId = session.user.id

  await requireKnowledgeEditAccess(event, wsId, userId)

  const body = await readBody<{
    knowledgeId?: unknown
    s3Key?: unknown
    filename?: unknown
    ext?: unknown
    mimeType?: unknown
  }>(event)

  const knowledgeId = typeof body?.knowledgeId === 'string' ? body.knowledgeId : ''
  const s3Key = typeof body?.s3Key === 'string' ? body.s3Key : ''
  const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
  const ext = typeof body?.ext === 'string' ? body.ext.toLowerCase() : ''
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : ''

  if (!knowledgeId || !s3Key || !filename || !ext || !mimeType) {
    throw createError({ statusCode: 400, message: 'Missing required fields' })
  }
  if (!SAFE_KEY_RE.test(s3Key)) {
    throw createError({ statusCode: 400, message: 'Invalid s3Key' })
  }
  if (!s3Key.startsWith(`workspaces/${wsId}/knowledge/`)) {
    throw createError({ statusCode: 400, message: 'Key does not belong to this workspace' })
  }
  // Bind the knowledgeId to the s3Key tail. The client echoes back
  // BOTH values it got from upload-request; if they don't line up it
  // means either a confused client (unlikely) or a crafted request
  // trying to claim an arbitrary S3 object under a freshly-minted
  // knowledgeId. Stays out of trouble either way.
  const expectedTail = `/${knowledgeId}.${ext}`
  if (!s3Key.endsWith(expectedTail)) {
    throw createError({ statusCode: 400, message: 'knowledgeId must match s3Key tail' })
  }

  // The upload must be one `upload-request` issued to THIS caller in THIS
  // workspace (atomic claim — a replayed or foreign knowledgeId finds
  // nothing). Anything else is a 404 before any S3 call, so confirm can
  // never HEAD, adopt or delete an object it didn't hand to this caller.
  const pendingRef = { workspaceId: wsId, userId, knowledgeId }
  const pending = await claimPendingKnowledgeUpload(pendingRef)
  if (!pending || pending.s3Key !== s3Key || pending.ext !== ext || pending.mimeType !== mimeType) {
    throw createError({ statusCode: 404, message: 'Upload not found' })
  }

  const config = useRuntimeConfig()
  const s3 = useS3Client()

  const releaseSlots = async () => {
    // Best-effort; rateLimit.ts swallows Valkey errors.
    await Promise.all([
      releaseInflightSlot(INFLIGHT_NS_WORKSPACE, wsId),
      releaseInflightSlot(INFLIGHT_NS_USER, String(userId))
    ])
  }
  const cleanupOrphanS3 = async () => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: s3Key }))
    } catch { /* object may already be gone */ }
  }

  try {
    let head
    try {
      head = await s3.send(new HeadObjectCommand({
        Bucket: config.s3.bucket,
        Key: s3Key
      }))
    } catch {
      // Not landed (yet) — keep the claim so the client can retry.
      await restorePendingKnowledgeUpload(pendingRef, pending)
      throw createError({ statusCode: 404, message: 'Upload not found in storage' })
    }
    const sizeBytes = head.ContentLength ?? 0
    if (sizeBytes <= 0) {
      await cleanupOrphanS3()
      throw createError({ statusCode: 400, message: 'Uploaded object has no size' })
    }

    // Magic-byte sniff. Runs before caps so a junk upload never
    // consumes workspace bytes — we reject, delete, and release.
    try {
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
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${wsId}))`)
        await assertCapsOnConfirm({ workspaceId: wsId, userId, size: sizeBytes })
        safeName = await disambiguateFilename(wsId, filename)
        await createKnowledge({
          knowledgeId,
          workspaceId: wsId,
          filename: safeName,
          sourceExt: ext,
          mimeType,
          sizeBytes,
          s3Key,
          embeddingVersion,
          uploaderId: userId
        })
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
      filename: safeName!,
      status: 'processing' as const
    }
  } finally {
    // Always release — success, cap rejection, content-type mismatch,
    // S3 missing, DB failure. The slot is a resource held during
    // upload; its life ends at confirm regardless of outcome.
    await releaseSlots()
  }
})
