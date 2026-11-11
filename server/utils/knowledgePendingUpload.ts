import * as Sentry from '@sentry/nuxt'
import { useValkey } from './valkey'

// Pending knowledge uploads: the record `upload-request` issues so that
// `confirm` only ever acts on an upload it handed to THIS caller, for
// THIS workspace — the knowledge counterpart of the `uploads` row behind
// `/api/upload/confirm`. Without it, an editor who learnt another
// member's freshly minted knowledgeId + key could confirm it as their
// own, or make confirm delete that original (cleanup on a failed sniff /
// cap check acts on the claimed key).
//
// Stored in Valkey under a key that names workspace + user + knowledgeId
// (TTL a little past the presigned URL's lifetime), so a caller can only
// ever look up their own records. Confirm CLAIMS it atomically (GETDEL):
// a second confirm of the same upload finds nothing and touches no S3
// object. Fails CLOSED: a Valkey error means no claim, i.e. a 404.

const KNOWLEDGE_PENDING_TTL_MS = 6 * 60 * 1000

export interface PendingKnowledgeRef {
  workspaceId: string
  userId: number
  knowledgeId: string
}

export interface PendingKnowledgeUpload {
  s3Key: string
  ext: string
  mimeType: string
}

function pendingKey(ref: PendingKnowledgeRef): string {
  return `knowledge-pending:${ref.workspaceId}:${ref.userId}:${ref.knowledgeId}`
}

function parsePending(raw: string | null): PendingKnowledgeUpload | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { s3Key, ext, mimeType } = value as Record<string, unknown>
    if (typeof s3Key !== 'string' || typeof ext !== 'string' || typeof mimeType !== 'string') return null
    return { s3Key, ext, mimeType }
  } catch {
    return null
  }
}

/** Record an upload issued by `upload-request`. Throws on Valkey errors (no presign without a record). */
export async function recordPendingKnowledgeUpload(ref: PendingKnowledgeRef, pending: PendingKnowledgeUpload): Promise<void> {
  await useValkey().set(pendingKey(ref), JSON.stringify(pending), 'PX', KNOWLEDGE_PENDING_TTL_MS)
}

/** Atomically take the caller's pending record for this upload, or null when there is none. */
export async function claimPendingKnowledgeUpload(ref: PendingKnowledgeRef): Promise<PendingKnowledgeUpload | null> {
  try {
    return parsePending(await useValkey().getdel(pendingKey(ref)))
  } catch (e) {
    console.warn('[knowledge] valkey error on pending-upload claim, failing closed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'knowledge', event: 'valkey_unavailable' } })
    return null
  }
}

/** Put a claimed record back (the object hadn't landed yet — the client may retry confirm). */
export async function restorePendingKnowledgeUpload(ref: PendingKnowledgeRef, pending: PendingKnowledgeUpload): Promise<void> {
  try {
    await useValkey().set(pendingKey(ref), JSON.stringify(pending), 'PX', KNOWLEDGE_PENDING_TTL_MS, 'NX')
  } catch { /* best-effort: the client re-requests the upload */ }
}
