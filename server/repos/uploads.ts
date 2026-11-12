import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { documents, uploads } from '../db/schema'
import { useDatabase, useDatabasePool } from '../db/client'
import { pooledWorkspaceIdsSubquery } from './workspaceSubscriptions'
import type { DocAccess, SystemActor, UserScope } from './proofs'

// Uploads repository. Powers the presigned-URL upload flow:
//   request → recordPending (row inserted as unconfirmed)
//   S3 PUT
//   confirm → findOwnUpload + markConfirmed (confirmedAt timestamp)
//
// The orphan-cleanup plugin reads stale unconfirmed rows + the full
// s3Key list to reconcile against S3.
//
// Rows of a document take its proof; an uploader's own rows take their
// `UserScope` and match `uploader_id`; the sweeps take a `SystemActor`.

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
export async function recordPending(doc: DocAccess<'write'>, input: Omit<PendingUploadInput, 'docId'>): Promise<void> {
  const db = useDatabase()
  await db.insert(uploads).values({ ...input, docId: doc.docId })
}

// Image storage quota: every upload row, pending or confirmed, counts against
// a quota, reserved when the presigned URL is issued. Check + insert run in ONE
// transaction under an advisory lock on the quota scope, so parallel requests
// can't all pass a "used + size <= max" check that only one should pass.
//
// Scope: images in a Team / Business workspace's documents count against that
// WORKSPACE's pool (`{kind: 'workspace'}`, joined through
// `documents.workspace_id`; no column on `uploads`, so a moved document takes
// its images along); everything else against the uploader (`{kind: 'user'}`),
// leaving out pooled workspaces' images while billing is on (`excludePooled`).

export type ImageQuotaScope
  = | { kind: 'user', uploaderId: number, excludePooled: boolean }
    | { kind: 'workspace', workspaceId: string }

type Tx = Parameters<Parameters<ReturnType<typeof useDatabase>['transaction']>[0]>[0]

async function lockQuotaScope(tx: Tx, scope: ImageQuotaScope): Promise<void> {
  const key = scope.kind === 'user' ? `image-quota:${scope.uploaderId}` : `image-quota:ws:${scope.workspaceId}`
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`)
}

function docsOfWorkspaces(workspaceIds: ReturnType<typeof sql>) {
  return sql`(select ${documents.docId} from ${documents} where ${documents.workspaceId} in ${workspaceIds})`
}

async function sumScopeBytes(tx: Tx | ReturnType<typeof useDatabase>, scope: ImageQuotaScope): Promise<number> {
  const where = scope.kind === 'workspace'
    ? sql`${uploads.docId} in ${docsOfWorkspaces(sql`(${scope.workspaceId})`)}`
    : scope.excludePooled
      ? and(eq(uploads.uploaderId, scope.uploaderId), sql`${uploads.docId} not in ${docsOfWorkspaces(pooledWorkspaceIdsSubquery())}`)
      : eq(uploads.uploaderId, scope.uploaderId)
  const rows = await tx
    .select({ total: sql<string | null>`coalesce(sum(${uploads.sizeBytes}), 0)` })
    .from(uploads)
    .where(where)
  return Number(rows[0]?.total ?? 0)
}

/** Bytes counted against the user's personal image quota (pending + confirmed rows). */
export async function sumImageBytesByUploader(self: UserScope, opts: { excludePooled?: boolean } = {}): Promise<number> {
  return sumScopeBytes(useDatabase(), { kind: 'user', uploaderId: self.userId, excludePooled: opts.excludePooled === true })
}

/** Bytes counted against a quota scope. */
export async function sumImageBytesInScope(scope: ImageQuotaScope): Promise<number> {
  return sumScopeBytes(useDatabase(), scope)
}

export interface QuotaReservation {
  reserved: boolean
  /** Bytes in use before this reservation. */
  usedBytes: number
}

/**
 * Insert a pending upload row if it fits the uploader's quota. Atomic per
 * uploader (advisory lock + sum + insert in one transaction).
 */
export async function reservePendingUpload(doc: DocAccess<'write'>, input: Omit<PendingUploadInput, 'docId'>, maxBytes: number, scope: ImageQuotaScope): Promise<QuotaReservation> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    await lockQuotaScope(tx, scope)
    const usedBytes = await sumScopeBytes(tx, scope)
    if (usedBytes + input.sizeBytes > maxBytes) return { reserved: false, usedBytes }
    await tx.insert(uploads).values({ ...input, docId: doc.docId })
    return { reserved: true, usedBytes }
  })
}

export type ConfirmOutcome = 'confirmed' | 'already-confirmed' | 'over-quota' | 'missing'

/**
 * Flip the caller's pending upload to confirmed, unless the uploader is
 * now over quota (e.g. the quota was lowered since the request), in which
 * case the row stays pending and the caller deletes it. The row's own
 * bytes were reserved at request time, so the check is "total <= max".
 */
export async function confirmOwnUploadWithinQuota(
  self: UserScope,
  s3Key: string,
  maxBytes: number,
  scope: ImageQuotaScope
): Promise<ConfirmOutcome> {
  const uploaderId = self.userId
  const db = useDatabase()
  return db.transaction(async (tx) => {
    await lockQuotaScope(tx, scope)
    const rows = await tx
      .select({ confirmedAt: uploads.confirmedAt })
      .from(uploads)
      .where(and(eq(uploads.s3Key, s3Key), eq(uploads.uploaderId, uploaderId)))
      .limit(1)
    const row = rows[0]
    if (!row) return 'missing'
    if (row.confirmedAt) return 'already-confirmed'
    if (await sumScopeBytes(tx, scope) > maxBytes) return 'over-quota'
    await tx
      .update(uploads)
      .set({ confirmedAt: new Date() })
      .where(and(eq(uploads.s3Key, s3Key), eq(uploads.uploaderId, uploaderId), isNull(uploads.confirmedAt)))
    return 'confirmed'
  })
}

export interface OwnUploadRow {
  docId: string
  contentType: string
  sizeBytes: number
  confirmedAt: Date | null
}

/**
 * The upload row `/api/upload/request` issued for `s3Key` to `uploaderId`,
 * confirmed or not. Null when the key was never issued to this user, in
 * which case /upload/confirm answers 404 without touching S3.
 */
export async function findOwnUpload(self: UserScope, s3Key: string): Promise<OwnUploadRow | null> {
  const uploaderId = self.userId
  const db = useDatabase()
  const rows = await db
    .select({
      docId: uploads.docId,
      contentType: uploads.contentType,
      sizeBytes: uploads.sizeBytes,
      confirmedAt: uploads.confirmedAt
    })
    .from(uploads)
    .where(and(eq(uploads.s3Key, s3Key), eq(uploads.uploaderId, uploaderId)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Flip an upload to confirmed by key alone. Only for server-issued keys
 * (AI image tool); the HTTP confirm path uses `confirmOwnUpload`.
 */
export async function markConfirmed(doc: DocAccess<'write'>, s3Key: string): Promise<void> {
  const db = useDatabase()
  await db.update(uploads).set({ confirmedAt: new Date() }).where(and(eq(uploads.s3Key, s3Key), eq(uploads.docId, doc.docId)))
}

/**
 * Atomically flip the caller's pending upload to confirmed. Returns false
 * when there was nothing to flip (already confirmed, or not theirs), so
 * concurrent double-confirms are harmless.
 */
export async function confirmOwnUpload(self: UserScope, s3Key: string): Promise<boolean> {
  const uploaderId = self.userId
  const db = useDatabase()
  const rows = await db
    .update(uploads)
    .set({ confirmedAt: new Date() })
    .where(and(eq(uploads.s3Key, s3Key), eq(uploads.uploaderId, uploaderId), isNull(uploads.confirmedAt)))
    .returning({ id: uploads.id })
  return rows.length > 0
}

/**
 * Drop the caller's still-pending row (content-sniff rejection). Never
 * touches a confirmed row.
 */
export async function deletePending(self: UserScope, s3Key: string): Promise<void> {
  const uploaderId = self.userId
  const db = useDatabase()
  await db
    .delete(uploads)
    .where(and(eq(uploads.s3Key, s3Key), eq(uploads.uploaderId, uploaderId), isNull(uploads.confirmedAt)))
}

/**
 * Uploads that are unconfirmed and older than `olderThanMs`. The
 * orphan-cleanup sweep deletes these after also removing the S3 object
 * (if any).
 */
export async function listStaleUnconfirmed(_by: SystemActor, olderThanMs: number): Promise<Array<{ s3Key: string }>> {
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
export async function purgeStaleUnconfirmed(_by: SystemActor, olderThanMs: number): Promise<void> {
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
export async function listAllS3Keys(_by: SystemActor): Promise<string[]> {
  const db = useDatabase()
  const rows = await db.select({ s3Key: uploads.s3Key }).from(uploads)
  return rows.map(r => r.s3Key)
}

/**
 * Delete every upload row for a doc. Called from deleteDocument,
 * cascades the DB side; S3 cleanup is separate.
 */
export async function deleteUploadsForDoc(doc: DocAccess<'delete'>): Promise<void> {
  const db = useDatabase()
  await db.delete(uploads).where(eq(uploads.docId, doc.docId))
}

/**
 * Every confirmed upload row for a doc. Used by the duplicate flow to
 * clone image assets into the new doc's S3 prefix. Unconfirmed rows are
 * skipped: their S3 object may not exist, and they'll be swept away
 * within 24h either way.
 */
export interface UploadRow {
  fileId: string
  contentType: string
  sizeBytes: number
  s3Key: string
  uploaderId: number | null
}

export async function listConfirmedUploadsForDoc(doc: DocAccess<'view'>): Promise<UploadRow[]> {
  const docId = doc.docId
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
  fileId: string
  uploaderId: number | null
  contentType: string
  sizeBytes: number
  s3Key: string
}

export async function insertConfirmedUploads(doc: DocAccess<'write'>, rows: InsertConfirmedUpload[]): Promise<void> {
  if (rows.length === 0) return
  const db = useDatabase()
  await db.insert(uploads).values(toConfirmedValues(doc, rows))
}

function toConfirmedValues(doc: DocAccess<'write'>, rows: InsertConfirmedUpload[]) {
  const now = new Date()
  return rows.map(r => ({
    docId: doc.docId,
    fileId: r.fileId,
    uploaderId: r.uploaderId,
    contentType: r.contentType,
    sizeBytes: r.sizeBytes,
    s3Key: r.s3Key,
    confirmedAt: now
  }))
}

/**
 * Insert already-confirmed rows (a duplicate's image copies) if their
 * total fits the quota scope (same advisory lock as uploads). Returns
 * false, inserting nothing, when it doesn't.
 */
export async function insertConfirmedUploadsWithinQuota(
  doc: DocAccess<'write'>,
  rows: InsertConfirmedUpload[],
  maxBytes: number,
  scope: ImageQuotaScope
): Promise<QuotaReservation> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    await lockQuotaScope(tx, scope)
    const usedBytes = await sumScopeBytes(tx, scope)
    const adding = rows.reduce((n, r) => n + r.sizeBytes, 0)
    if (usedBytes + adding > maxBytes) return { reserved: false, usedBytes }
    if (rows.length > 0) await tx.insert(uploads).values(toConfirmedValues(doc, rows))
    return { reserved: true, usedBytes }
  })
}

// Image garbage collection (see server/utils/storage/imageGc.ts)

export interface GcCandidate {
  id: number
  fileId: string
  s3Key: string
  unreferencedSince: Date | null
}

/**
 * Docs that have at least one confirmed upload eligible for a GC check:
 * confirmed before `confirmedBefore` and not checked since `checkedBefore`.
 * Least-recently-checked first so every doc gets its turn.
 */
export async function listGcCandidateDocIds(_by: SystemActor, args: {
  confirmedBefore: Date
  checkedBefore: Date
  limit: number
}): Promise<string[]> {
  const db = useDatabase()
  const rows = await db
    .select({ docId: uploads.docId })
    .from(uploads)
    .where(and(
      lt(uploads.confirmedAt, args.confirmedBefore),
      or(isNull(uploads.gcCheckedAt), lt(uploads.gcCheckedAt, args.checkedBefore))
    ))
    .groupBy(uploads.docId)
    .orderBy(sql`min(coalesce(${uploads.gcCheckedAt}, 'epoch'::timestamptz))`)
    .limit(args.limit)
  return rows.map(r => r.docId)
}

/** The doc's confirmed uploads old enough to be checked. */
export async function listGcCandidatesForDoc(doc: DocAccess<'manage'>, confirmedBefore: Date): Promise<GcCandidate[]> {
  const docId = doc.docId
  const db = useDatabase()
  return db
    .select({
      id: uploads.id,
      fileId: uploads.fileId,
      s3Key: uploads.s3Key,
      unreferencedSince: uploads.unreferencedSince
    })
    .from(uploads)
    .where(and(eq(uploads.docId, docId), lt(uploads.confirmedAt, confirmedBefore)))
}

/**
 * Record a GC check: referenced rows get `unreferenced_since = NULL`,
 * unreferenced rows keep an existing stamp or get `now`.
 */
export async function recordGcCheck(_by: SystemActor, args: {
  referencedIds: number[]
  unreferencedIds: number[]
  now: Date
}): Promise<void> {
  const db = useDatabase()
  if (args.referencedIds.length > 0) {
    await db
      .update(uploads)
      .set({ gcCheckedAt: args.now, unreferencedSince: null })
      .where(inArray(uploads.id, args.referencedIds))
  }
  if (args.unreferencedIds.length > 0) {
    await db
      .update(uploads)
      .set({ gcCheckedAt: args.now, unreferencedSince: sql`coalesce(${uploads.unreferencedSince}, ${args.now})` })
      .where(inArray(uploads.id, args.unreferencedIds))
  }
}

/**
 * Delete the row if it is STILL marked unreferenced since before `cutoff`
 * (a concurrent check that found a reference clears the stamp and wins).
 * Returns the S3 key to delete, or null when the row was kept.
 */
export async function deleteExpiredUnreferencedUpload(_by: SystemActor, id: number, cutoff: Date): Promise<string | null> {
  const db = useDatabase()
  const rows = await db
    .delete(uploads)
    .where(and(eq(uploads.id, id), lt(uploads.unreferencedSince, cutoff)))
    .returning({ s3Key: uploads.s3Key })
  return rows[0]?.s3Key ?? null
}

/** S3 keys of the document's confirmed uploads among `fileIds` (what a published page copies). */
export async function listConfirmedUploadKeys(doc: DocAccess<'view'>, fileIds: readonly string[]): Promise<Map<string, string>> {
  if (fileIds.length === 0) return new Map()
  const rows = await useDatabase().select({ fileId: uploads.fileId, s3Key: uploads.s3Key }).from(uploads)
    .where(and(eq(uploads.docId, doc.docId), inArray(uploads.fileId, [...fileIds]), isNotNull(uploads.confirmedAt)))
  return new Map(rows.map(r => [r.fileId, r.s3Key]))
}

/**
 * Which of `paths` (`{docId}/{fileId}`) occur anywhere outside their own
 * document's replay: raw Y.js bytes of every document, themes, workspace
 * default themes, comments, activity metadata (the image GC's safety net).
 */
export async function findReferencedUploadPaths(_by: SystemActor, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const res = await useDatabasePool().query<{ path: string }>(
    `SELECT p.path FROM unnest($1::text[]) AS p(path)
     WHERE EXISTS (SELECT 1 FROM yjs_updates y
                   WHERE position(convert_to(p.path, 'UTF8') IN y.data) > 0)
        OR EXISTS (SELECT 1 FROM documents d WHERE strpos(d.theme::text, p.path) > 0)
        OR EXISTS (SELECT 1 FROM workspaces w WHERE strpos(w.default_theme::text, p.path) > 0)
        OR EXISTS (SELECT 1 FROM themes t WHERE strpos(t.theme::text, p.path) > 0)
        OR EXISTS (SELECT 1 FROM document_comments c WHERE strpos(c.body, p.path) > 0)
        OR EXISTS (SELECT 1 FROM activity_log a WHERE strpos(a.metadata::text, p.path) > 0)`,
    [[...paths]]
  )
  return new Set(res.rows.map(r => r.path))
}
