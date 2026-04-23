import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { uploads } from '../db/schema'
import { useDatabase } from '../utils/database'

// Uploads repository. Powers the presigned-URL upload flow:
//   request → recordPending (row inserted as unconfirmed)
//   S3 PUT
//   confirm → markConfirmed (confirmedAt timestamp)
//
// The orphan-cleanup plugin reads stale unconfirmed rows + the full
// s3Key list to reconcile against S3.

export interface PendingUploadInput {
  docId: string
  fileId: string
  uploaderId: number
  contentType: string
  sizeBytes: number
  s3Key: string
}

/**
 * Insert an unconfirmed upload row. Called before the client receives
 * the presigned PUT URL, so the orphan-cleanup sweep has a record to
 * compare against.
 */
export async function recordPending(input: PendingUploadInput): Promise<void> {
  const db = useDatabase()
  await db.insert(uploads).values(input)
}

/**
 * Flip an upload to confirmed. Called after the HEAD-object check
 * succeeds in /upload/confirm. Matches by s3Key — the client gets the
 * full key back from /upload/request.
 */
export async function markConfirmed(s3Key: string): Promise<void> {
  const db = useDatabase()
  await db.update(uploads).set({ confirmedAt: new Date() }).where(eq(uploads.s3Key, s3Key))
}

/**
 * Uploads that are unconfirmed and older than `olderThanMs`. The
 * orphan-cleanup sweep deletes these after also removing the S3 object
 * (if any).
 */
export async function listStaleUnconfirmed(olderThanMs: number): Promise<Array<{ s3Key: string }>> {
  const db = useDatabase()
  const cutoff = new Date(Date.now() - olderThanMs)
  return db
    .select({ s3Key: uploads.s3Key })
    .from(uploads)
    .where(and(isNull(uploads.confirmedAt), lt(uploads.createdAt, cutoff)))
}

/**
 * Delete unconfirmed rows older than the cutoff. Used by the
 * orphan-cleanup sweep after the S3 side has been cleared.
 */
export async function purgeStaleUnconfirmed(olderThanMs: number): Promise<void> {
  const db = useDatabase()
  const cutoff = new Date(Date.now() - olderThanMs)
  await db
    .delete(uploads)
    .where(and(isNull(uploads.confirmedAt), lt(uploads.createdAt, cutoff)))
}

/**
 * Every s3Key we know about. Used by orphan-cleanup to reconcile
 * against S3's actual object list.
 */
export async function listAllS3Keys(): Promise<string[]> {
  const db = useDatabase()
  const rows = await db.select({ s3Key: uploads.s3Key }).from(uploads)
  return rows.map(r => r.s3Key)
}

/**
 * Delete every upload row for a doc. Called from deleteDocument —
 * cascades the DB side; S3 cleanup is separate.
 */
export async function deleteUploadsForDoc(docId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(uploads).where(eq(uploads.docId, docId))
}

/**
 * Every confirmed upload row for a doc. Used by the duplicate flow to
 * clone image assets into the new doc's S3 prefix. Unconfirmed rows are
 * skipped — their S3 object may not exist, and they'll be swept away
 * within 24h either way.
 */
export interface UploadRow {
  fileId: string
  contentType: string
  sizeBytes: number
  s3Key: string
  uploaderId: number | null
}

export async function listConfirmedUploadsForDoc(docId: string): Promise<UploadRow[]> {
  const db = useDatabase()
  return db
    .select({
      fileId: uploads.fileId,
      contentType: uploads.contentType,
      sizeBytes: uploads.sizeBytes,
      s3Key: uploads.s3Key,
      uploaderId: uploads.uploaderId
    })
    .from(uploads)
    .where(and(eq(uploads.docId, docId), sql`${uploads.confirmedAt} is not null`))
}

/**
 * Bulk-insert already-confirmed upload rows for a doc. Each row carries
 * a fresh s3Key (caller is responsible for having CopyObject'd the
 * underlying S3 objects before this runs).
 */
export interface InsertConfirmedUpload {
  docId: string
  fileId: string
  uploaderId: number | null
  contentType: string
  sizeBytes: number
  s3Key: string
}

export async function insertConfirmedUploads(rows: InsertConfirmedUpload[]): Promise<void> {
  if (rows.length === 0) return
  const db = useDatabase()
  const now = new Date()
  await db.insert(uploads).values(rows.map(r => ({
    docId: r.docId,
    fileId: r.fileId,
    uploaderId: r.uploaderId,
    contentType: r.contentType,
    sizeBytes: r.sizeBytes,
    s3Key: r.s3Key,
    confirmedAt: now
  })))
}
