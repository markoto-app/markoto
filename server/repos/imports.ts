import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { importJobItems, importJobs } from '../db/schema'
import { useDatabase } from '../db/client'
import type { SystemActor, UserScope } from './proofs'
import {
  ACTIVE_IMPORT_JOB_STATUSES,
  type ImportItemKind,
  type ImportItemReason,
  type ImportItemStatus,
  type ImportJobSource,
  type ImportJobStatus
} from '~~/shared/config/imports'

// Bulk import jobs and their files. A user reaches only their own jobs
// (`UserScope`); the worker and the sweeper act as named jobs (`SystemActor`).

export interface ImportJobRow {
  jobId: string
  userId: number
  workspaceId: string | null
  targetFolderId: string | null
  source: ImportJobSource
  sourceRef: string | null
  status: ImportJobStatus
  cancelRequested: boolean
  total: number
  done: number
  failed: number
  skipped: number
  totalBytes: number
  error: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export interface ImportItemRow {
  itemId: string
  relativePath: string
  kind: ImportItemKind
  status: ImportItemStatus
  reason: ImportItemReason | null
  plannedDocId: string | null
  docId: string | null
  s3Key: string | null
  sizeBytes: number
  imagesSkipped: number
}

export interface NewImportItem {
  itemId: string
  relativePath: string
  kind: ImportItemKind
  s3Key: string | null
  sizeBytes: number
  plannedDocId?: string | null
  status?: ImportItemStatus
  reason?: ImportItemReason | null
}

const jobColumns = {
  jobId: importJobs.jobId,
  userId: importJobs.userId,
  workspaceId: importJobs.workspaceId,
  targetFolderId: importJobs.targetFolderId,
  source: importJobs.source,
  sourceRef: importJobs.sourceRef,
  status: importJobs.status,
  cancelRequested: importJobs.cancelRequested,
  total: importJobs.total,
  done: importJobs.done,
  failed: importJobs.failed,
  skipped: importJobs.skipped,
  totalBytes: importJobs.totalBytes,
  error: importJobs.error,
  createdAt: importJobs.createdAt,
  startedAt: importJobs.startedAt,
  finishedAt: importJobs.finishedAt
}

const itemColumns = {
  itemId: importJobItems.itemId,
  relativePath: importJobItems.relativePath,
  kind: importJobItems.kind,
  status: importJobItems.status,
  reason: importJobItems.reason,
  plannedDocId: importJobItems.plannedDocId,
  docId: importJobItems.docId,
  s3Key: importJobItems.s3Key,
  sizeBytes: importJobItems.sizeBytes,
  imagesSkipped: importJobItems.imagesSkipped
}

/** Insert in chunks: a job can have thousands of items. */
async function insertItems(jobId: string, items: readonly NewImportItem[], db = useDatabase()): Promise<void> {
  for (let i = 0; i < items.length; i += 500) {
    await db.insert(importJobItems).values(items.slice(i, i + 500).map(it => ({
      jobId,
      itemId: it.itemId,
      relativePath: it.relativePath,
      kind: it.kind,
      s3Key: it.s3Key,
      sizeBytes: it.sizeBytes,
      plannedDocId: it.plannedDocId ?? null,
      status: it.status ?? 'pending',
      reason: it.reason ?? null
    })))
  }
}

/**
 * Create a job for the user with its items. Refused (null) when the user
 * already has an active job: one import at a time, checked under a per-user
 * lock so two requests can't both start one.
 */
export async function createImportJob(self: UserScope, input: {
  jobId: string
  workspaceId: string | null
  targetFolderId: string | null
  source: ImportJobSource
  sourceRef: string | null
  status: 'uploading' | 'queued'
  total: number
  skipped: number
  totalBytes: number
  items: readonly NewImportItem[]
}): Promise<ImportJobRow | null> {
  return useDatabase().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`import-job:${self.userId}`}))`)
    const active = await tx.select({ jobId: importJobs.jobId }).from(importJobs)
      .where(and(eq(importJobs.userId, self.userId), inArray(importJobs.status, [...ACTIVE_IMPORT_JOB_STATUSES]))).limit(1)
    if (active.length > 0) return null
    const row = (await tx.insert(importJobs).values({
      jobId: input.jobId,
      userId: self.userId,
      workspaceId: input.workspaceId,
      targetFolderId: input.targetFolderId,
      source: input.source,
      sourceRef: input.sourceRef,
      status: input.status,
      total: input.total,
      skipped: input.skipped,
      totalBytes: input.totalBytes
    }).returning(jobColumns))[0]
    if (!row) throw new Error('createImportJob: insert returned nothing')
    for (let i = 0; i < input.items.length; i += 500) {
      await tx.insert(importJobItems).values(input.items.slice(i, i + 500).map(it => ({
        jobId: input.jobId,
        itemId: it.itemId,
        relativePath: it.relativePath,
        kind: it.kind,
        s3Key: it.s3Key,
        sizeBytes: it.sizeBytes,
        plannedDocId: it.plannedDocId ?? null,
        status: it.status ?? 'pending',
        reason: it.reason ?? null
      })))
    }
    return row
  })
}

/** Jobs the user started since `since` (the daily limit). */
export async function countImportJobsSince(self: UserScope, since: Date): Promise<number> {
  const r = await useDatabase().select({ n: sql<number>`count(*)::int` }).from(importJobs)
    .where(and(eq(importJobs.userId, self.userId), gte(importJobs.createdAt, since)))
  return Number(r[0]?.n ?? 0)
}

export async function getImportJob(self: UserScope, jobId: string): Promise<ImportJobRow | null> {
  return (await useDatabase().select(jobColumns).from(importJobs)
    .where(and(eq(importJobs.jobId, jobId), eq(importJobs.userId, self.userId))).limit(1))[0] ?? null
}

/** The user's recent jobs, newest first; with `workspaceId` (null = personal) only those into that scope. */
export async function listImportJobs(self: UserScope, scope: { workspaceId: string | null } | null, limit: number): Promise<ImportJobRow[]> {
  const where = scope === null
    ? eq(importJobs.userId, self.userId)
    : and(eq(importJobs.userId, self.userId), scope.workspaceId === null ? isNull(importJobs.workspaceId) : eq(importJobs.workspaceId, scope.workspaceId))
  return useDatabase().select(jobColumns).from(importJobs).where(where).orderBy(desc(importJobs.createdAt)).limit(limit)
}

/** Items of the user's job: failed and skipped ones (for the result list), or all. */
export async function listImportItems(self: UserScope, jobId: string, opts: { problemsOnly: boolean, limit: number }): Promise<ImportItemRow[]> {
  const job = await getImportJob(self, jobId)
  if (!job) return []
  return useDatabase().select(itemColumns).from(importJobItems)
    .where(and(
      eq(importJobItems.jobId, jobId),
      opts.problemsOnly ? inArray(importJobItems.status, ['failed', 'skipped']) : undefined
    ))
    .orderBy(asc(importJobItems.relativePath))
    .limit(opts.limit)
}

/** The uploaded files of the user's job in `uploading` state (start: which ones arrived). */
export async function listUploadingItems(self: UserScope, jobId: string): Promise<Array<{ itemId: string, s3Key: string | null, sizeBytes: number }>> {
  const job = await getImportJob(self, jobId)
  if (!job || job.status !== 'uploading') return []
  return useDatabase().select({ itemId: importJobItems.itemId, s3Key: importJobItems.s3Key, sizeBytes: importJobItems.sizeBytes })
    .from(importJobItems).where(eq(importJobItems.jobId, jobId))
}

/** `uploading` → `queued`. False when the job is not the user's or not uploading. */
export async function queueImportJob(self: UserScope, jobId: string): Promise<boolean> {
  const r = await useDatabase().update(importJobs).set({ status: 'queued' })
    .where(and(eq(importJobs.jobId, jobId), eq(importJobs.userId, self.userId), eq(importJobs.status, 'uploading')))
    .returning({ jobId: importJobs.jobId })
  return r.length > 0
}

/**
 * Ask a job to stop. A job not yet running stops at once (`cancelled`); a
 * running one at its next file. Documents already created stay.
 */
export async function cancelImportJob(self: UserScope, jobId: string): Promise<ImportJobStatus | null> {
  const db = useDatabase()
  const stopped = await db.update(importJobs).set({ status: 'cancelled', cancelRequested: true, finishedAt: new Date() })
    .where(and(eq(importJobs.jobId, jobId), eq(importJobs.userId, self.userId), inArray(importJobs.status, ['uploading', 'queued'])))
    .returning({ status: importJobs.status })
  if (stopped[0]) return stopped[0].status
  const running = await db.update(importJobs).set({ cancelRequested: true })
    .where(and(eq(importJobs.jobId, jobId), eq(importJobs.userId, self.userId), eq(importJobs.status, 'running')))
    .returning({ status: importJobs.status })
  if (running[0]) return running[0].status
  return (await getImportJob(self, jobId))?.status ?? null
}

// ---------- worker ----------

/** Claim the oldest queued job (`running`, heartbeat now). `FOR UPDATE SKIP LOCKED`: several workers take different jobs. */
export async function claimQueuedImportJob(_by: SystemActor): Promise<ImportJobRow | null> {
  const r = await useDatabase().execute<{ job_id: string }>(sql`
    WITH next AS (
      SELECT id FROM import_jobs WHERE status = 'queued'
      ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE import_jobs SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now()
    WHERE id IN (SELECT id FROM next)
    RETURNING job_id
  `)
  const jobId = r.rows[0]?.job_id
  if (!jobId) return null
  return getImportJobForWorker(_by, jobId)
}

export async function getImportJobForWorker(_by: SystemActor, jobId: string): Promise<ImportJobRow | null> {
  return (await useDatabase().select(jobColumns).from(importJobs).where(eq(importJobs.jobId, jobId)).limit(1))[0] ?? null
}

/** Stamp the heartbeat and read the cancel flag. */
export async function importJobHeartbeat(_by: SystemActor, jobId: string): Promise<{ cancelRequested: boolean }> {
  const r = await useDatabase().update(importJobs).set({ heartbeatAt: new Date() })
    .where(eq(importJobs.jobId, jobId)).returning({ cancelRequested: importJobs.cancelRequested })
  return { cancelRequested: r[0]?.cancelRequested ?? true }
}

export async function listJobItems(_by: SystemActor, jobId: string): Promise<ImportItemRow[]> {
  return useDatabase().select(itemColumns).from(importJobItems).where(eq(importJobItems.jobId, jobId)).orderBy(asc(importJobItems.id))
}

/** Items found by the worker inside an archive or a repository. */
export async function addJobItems(_by: SystemActor, jobId: string, items: readonly NewImportItem[]): Promise<void> {
  await insertItems(jobId, items)
}

export async function setJobItemPlan(_by: SystemActor, jobId: string, itemId: string, plannedDocId: string): Promise<void> {
  await useDatabase().update(importJobItems).set({ plannedDocId })
    .where(and(eq(importJobItems.jobId, jobId), eq(importJobItems.itemId, itemId)))
}

/** Record how one item ended. */
export async function finishJobItem(_by: SystemActor, jobId: string, itemId: string, outcome: {
  status: Exclude<ImportItemStatus, 'pending'>
  reason?: ImportItemReason | null
  docId?: string | null
  imagesSkipped?: number
}): Promise<void> {
  await useDatabase().update(importJobItems).set({
    status: outcome.status,
    reason: outcome.reason ?? null,
    ...(outcome.docId !== undefined ? { docId: outcome.docId } : {}),
    ...(outcome.imagesSkipped !== undefined ? { imagesSkipped: outcome.imagesSkipped } : {})
  }).where(and(eq(importJobItems.jobId, jobId), eq(importJobItems.itemId, itemId)))
}

/** Recount the job's counters from its document items. */
export async function refreshJobCounters(_by: SystemActor, jobId: string): Promise<void> {
  await useDatabase().execute(sql`
    UPDATE import_jobs j SET
      total = c.total, done = c.done, failed = c.failed, skipped = c.skipped
    FROM (
      SELECT
        count(*) FILTER (WHERE kind = 'doc')::int AS total,
        count(*) FILTER (WHERE kind = 'doc' AND status = 'done')::int AS done,
        count(*) FILTER (WHERE kind = 'doc' AND status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'skipped')::int AS skipped
      FROM import_job_items WHERE job_id = ${jobId}
    ) c
    WHERE j.job_id = ${jobId}
  `)
}

export async function finishImportJob(_by: SystemActor, jobId: string, status: 'done' | 'failed' | 'cancelled', error: string | null = null): Promise<void> {
  await useDatabase().update(importJobs).set({ status, error, finishedAt: new Date(), heartbeatAt: null })
    .where(eq(importJobs.jobId, jobId))
}

/** Running jobs whose instance stopped (stale heartbeat) are queued again; their finished items are kept. */
export async function requeueStaleImportJobs(_by: SystemActor, heartbeatBefore: Date): Promise<number> {
  const r = await useDatabase().update(importJobs).set({ status: 'queued', heartbeatAt: null })
    .where(and(eq(importJobs.status, 'running'), or(isNull(importJobs.heartbeatAt), lt(importJobs.heartbeatAt, heartbeatBefore))))
    .returning({ jobId: importJobs.jobId })
  return r.length
}

/** Jobs left in `uploading` (the browser went away) older than `before`: their staging keys, then the rows go. */
export async function listAbandonedUploads(_by: SystemActor, before: Date): Promise<Array<{ jobId: string, keys: string[] }>> {
  const jobs = await useDatabase().select({ jobId: importJobs.jobId }).from(importJobs)
    .where(and(eq(importJobs.status, 'uploading'), lt(importJobs.createdAt, before))).limit(50)
  const out: Array<{ jobId: string, keys: string[] }> = []
  for (const j of jobs) {
    const keys = await useDatabase().select({ s3Key: importJobItems.s3Key }).from(importJobItems).where(eq(importJobItems.jobId, j.jobId))
    out.push({ jobId: j.jobId, keys: keys.flatMap(k => (k.s3Key ? [k.s3Key] : [])) })
  }
  return out
}

/** Delete jobs finished (or abandoned) before `before`, with their items. */
export async function deleteImportJobsBefore(_by: SystemActor, before: Date, jobIds?: readonly string[]): Promise<number> {
  const where = jobIds
    ? inArray(importJobs.jobId, [...jobIds])
    : and(inArray(importJobs.status, ['done', 'failed', 'cancelled']), lt(importJobs.finishedAt, before))
  if (jobIds && jobIds.length === 0) return 0
  const r = await useDatabase().delete(importJobs).where(where).returning({ jobId: importJobs.jobId })
  return r.length
}

/** The user's import records for the data export (no file contents: names, counts, outcome). */
export async function listImportJobsForExport(self: UserScope): Promise<Array<ImportJobRow & { items: Array<{ relativePath: string, status: ImportItemStatus, reason: ImportItemReason | null, docId: string | null }> }>> {
  const jobs = await listImportJobs(self, null, 1000)
  const out = []
  for (const job of jobs) {
    const items = await useDatabase().select({ relativePath: importJobItems.relativePath, status: importJobItems.status, reason: importJobItems.reason, docId: importJobItems.docId })
      .from(importJobItems).where(eq(importJobItems.jobId, job.jobId)).orderBy(asc(importJobItems.id))
    out.push({ ...job, items })
  }
  return out
}
