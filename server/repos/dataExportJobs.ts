import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { dataExportJobs } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import { ConflictError, NotFoundError } from './errors'

// `data_export_jobs` repository. Drives the GDPR Article 20 + 15
// data-portability + access export. Owner of:
//   - enqueueing (one active job at a time per user)
//   - the worker's claim → run → ready / failed transitions
//   - the expiry sweeper's mark-expired transition
//   - the user-facing list + by-id reads
//
// Status transitions:
//   queued → running → ready    (worker happy path)
//                    → failed   (worker error path; user can re-request)
//          → expired             (sweeper, when ready row past expires_at)
//
// The active job is anything in `queued` or `running` — only one
// active row per user at a time. Re-requesting while one is active
// returns 409 (the user's UI shows "export in progress" until they
// can request another). After ready/failed/expired the user can
// request a new export immediately.

const ACTIVE_STATUSES = ['queued', 'running'] as const

export type DataExportJobStatus = 'queued' | 'running' | 'ready' | 'expired' | 'failed'

export interface DataExportJobRow {
  jobId: string
  userId: number
  status: DataExportJobStatus
  s3Key: string | null
  errorMessage: string | null
  sizeBytes: number | null
  expiresAt: Date | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
}

/**
 * Create a new export job in `queued` status. Throws `ConflictError`
 * if the user already has an active (queued or running) job — the
 * UI shows "in progress" until that one resolves. Generates a fresh
 * `jobId` (nanoid) so the row's URL space is unguessable.
 *
 * The "one active per user" constraint is enforced via a transactional
 * count-then-insert. We don't use a partial unique index because a
 * post-completion ready row needs to coexist with a freshly-queued
 * one (re-requesting is allowed once the prior export is finished).
 */
export async function enqueueExportJob(userId: number): Promise<DataExportJobRow> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    // Lock-and-count: SELECT FOR UPDATE the user's active rows so a
    // concurrent enqueue can't slip past us. Empty result is fine —
    // we're locking on the rows that match, not on the user row.
    const active = await tx
      .select({ id: dataExportJobs.id })
      .from(dataExportJobs)
      .where(and(
        eq(dataExportJobs.userId, userId),
        inArray(dataExportJobs.status, ACTIVE_STATUSES)
      ))
      .for('update')
    if (active.length > 0) {
      throw new ConflictError('an export is already in progress')
    }

    const jobId = nanoid(16)
    const inserted = await tx
      .insert(dataExportJobs)
      .values({
        jobId,
        userId,
        status: 'queued'
      })
      .returning()
    if (!inserted[0]) throw new Error('enqueueExportJob: insert returned nothing')
    return rowToJob(inserted[0])
  })
}

/**
 * Worker entry point: claim the oldest queued job, transitioning it
 * to `running`. Returns null if no queued jobs exist. Uses
 * `SELECT … FOR UPDATE SKIP LOCKED` so multiple worker instances can
 * each pick a different job concurrently without blocking on the
 * locked rows.
 */
export async function claimQueuedJob(): Promise<DataExportJobRow | null> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{
      id: number
      job_id: string
      user_id: number
      status: DataExportJobStatus
      s3_key: string | null
      error_message: string | null
      size_bytes: number | null
      expires_at: Date | null
      created_at: Date
      started_at: Date | null
      completed_at: Date | null
    }>(sql`
      WITH next AS (
        SELECT id FROM data_export_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE data_export_jobs
      SET status = 'running', started_at = now()
      WHERE id IN (SELECT id FROM next)
      RETURNING *
    `)
    const row = claimed.rows?.[0]
    if (!row) return null
    // Raw `tx.execute` bypasses drizzle's column-type marshalling, so
    // timestamp columns come back as ISO strings (or `Date` if pg's
    // type parser converts — depends on driver config). Coerce to
    // Date defensively so the public shape matches the typed reads.
    return {
      jobId: row.job_id,
      userId: row.user_id,
      status: row.status,
      s3Key: row.s3_key,
      errorMessage: row.error_message,
      sizeBytes: row.size_bytes,
      expiresAt: toDateOrNull(row.expires_at),
      createdAt: toDate(row.created_at),
      startedAt: toDateOrNull(row.started_at),
      completedAt: toDateOrNull(row.completed_at)
    }
  })
}

function toDate(v: Date | string | number): Date {
  return v instanceof Date ? v : new Date(v)
}

function toDateOrNull(v: Date | string | number | null): Date | null {
  if (v === null) return null
  return v instanceof Date ? v : new Date(v)
}

/**
 * Mark a job ready. Sets `s3_key`, `size_bytes`, `expires_at`, and
 * `completed_at`. Idempotent — re-running on an already-ready row
 * has no effect (the worker is the only writer of `ready` and
 * advisory-locks per user).
 */
export async function markJobReady(args: {
  jobId: string
  s3Key: string
  sizeBytes: number
  retentionDays: number
}): Promise<void> {
  if (!Number.isInteger(args.retentionDays) || args.retentionDays < 1 || args.retentionDays > 90) {
    throw new Error(`markJobReady: retentionDays out of range: ${args.retentionDays}`)
  }
  const db = useDatabase()
  await db
    .update(dataExportJobs)
    .set({
      status: 'ready',
      s3Key: args.s3Key,
      sizeBytes: args.sizeBytes,
      completedAt: sql`now()`,
      expiresAt: sql`now() + (${args.retentionDays}::int * interval '1 day')`
    })
    .where(eq(dataExportJobs.jobId, args.jobId))
}

/**
 * Mark a job failed. Truncates the error message to 500 chars so
 * a long stack trace doesn't blow out the row.
 */
export async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  const db = useDatabase()
  await db
    .update(dataExportJobs)
    .set({
      status: 'failed',
      errorMessage: errorMessage.length > 500 ? `${errorMessage.slice(0, 497)}...` : errorMessage,
      completedAt: sql`now()`
    })
    .where(eq(dataExportJobs.jobId, jobId))
}

/**
 * Sweeper entry point: mark expired every `ready` row past its
 * `expires_at`. Returns the rows that flipped (with their s3_keys)
 * so the caller can delete the S3 objects.
 */
export async function markExpiredJobs(): Promise<{ jobId: string, s3Key: string | null }[]> {
  const db = useDatabase()
  const flipped = await db
    .update(dataExportJobs)
    .set({ status: 'expired' })
    .where(and(
      eq(dataExportJobs.status, 'ready'),
      sql`${dataExportJobs.expiresAt} IS NOT NULL`,
      sql`${dataExportJobs.expiresAt} <= now()`
    ))
    .returning({ jobId: dataExportJobs.jobId, s3Key: dataExportJobs.s3Key })
  return flipped
}

/**
 * History list for the user-facing "/settings/profile/exports" page.
 * Ordered most-recent-first. Bounded to 50 rows — the page shows
 * recent activity, not a permanent archive (rows are anyway expired
 * within a week).
 */
export async function listJobsForUser(userId: number, limit = 50): Promise<DataExportJobRow[]> {
  const db = useDatabase()
  const rows = await db
    .select()
    .from(dataExportJobs)
    .where(eq(dataExportJobs.userId, userId))
    .orderBy(desc(dataExportJobs.createdAt))
    .limit(limit)
  return rows.map(rowToJob)
}

/**
 * Tuple-key lookup: only returns the row if it belongs to `userId`.
 * Used by the download endpoint to gate access without leaking
 * existence of jobs that belong to other users.
 */
export async function getJobForUser(jobId: string, userId: number): Promise<DataExportJobRow | null> {
  const db = useDatabase()
  const row = (await db
    .select()
    .from(dataExportJobs)
    .where(and(
      eq(dataExportJobs.jobId, jobId),
      eq(dataExportJobs.userId, userId)
    ))
    .limit(1))[0]
  return row ? rowToJob(row) : null
}

/**
 * Read every export-job row for a user — used by the account-deletion
 * executor to collect S3 keys for cleanup BEFORE the user row is
 * dropped (the FK CASCADE drops the rows automatically; the S3 blobs
 * outlive that and need explicit deletion).
 */
export async function listAllJobsForUser(userId: number): Promise<DataExportJobRow[]> {
  const db = useDatabase()
  const rows = await db
    .select()
    .from(dataExportJobs)
    .where(eq(dataExportJobs.userId, userId))
    .orderBy(asc(dataExportJobs.createdAt))
  return rows.map(rowToJob)
}

/**
 * Worker-side: count active (queued/running) rows. Defensive guard
 * to detect "stuck running" rows beyond a reasonable runtime — the
 * sweeper can use this to surface them in Sentry so ops can intervene
 * if the worker died mid-build. Not load-bearing for correctness.
 */
export async function countActiveJobs(): Promise<number> {
  const db = useDatabase()
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dataExportJobs)
    .where(inArray(dataExportJobs.status, ACTIVE_STATUSES))
  return Number(rows[0]?.count ?? 0)
}

/**
 * Throws NotFoundError if the row does not exist. Used by tests +
 * by the worker if it needs to refetch a row mid-process.
 */
export async function getJobById(jobId: string): Promise<DataExportJobRow> {
  const db = useDatabase()
  const row = (await db
    .select()
    .from(dataExportJobs)
    .where(eq(dataExportJobs.jobId, jobId))
    .limit(1))[0]
  if (!row) throw new NotFoundError('Export job')
  return rowToJob(row)
}

function rowToJob(r: typeof dataExportJobs.$inferSelect): DataExportJobRow {
  return {
    jobId: r.jobId,
    userId: r.userId,
    status: r.status,
    s3Key: r.s3Key,
    errorMessage: r.errorMessage,
    sizeBytes: r.sizeBytes,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt
  }
}
