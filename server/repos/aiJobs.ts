import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { aiJobs, aiJobUnits, type AI_JOB_STATUSES, type AI_JOB_UNIT_STATUSES } from '../db/schema'
import { useDatabase } from '../db/client'
import { proofActingUserId, type DocAccess, type SystemActor, type UserScope } from './proofs'
import type { AiJobEstimate, AiJobParams, AiJobUnitOutput } from '../db/columnTypes'

export type { AiJobEstimate, AiJobParams, AiJobUnitOutput } from '../db/columnTypes'

// `ai_jobs` + `ai_job_units`: delegated large-scale edits (the engine is
// `server/utils/ai/jobs/`). A job is created for its initiator on one
// document (`createAiJob` takes the document proof and reads the user from
// it); the runner and the sweeper act as named jobs (`system('ai-jobs')`,
// `system('ai-jobs-sweep')`) carrying out what the initiator started, and
// re-check the initiator's edit right per unit themselves. Reads for the
// document's UI take a document proof and only see that document's jobs.

export type AiJobStatus = typeof AI_JOB_STATUSES[number]
export type AiJobUnitStatus = typeof AI_JOB_UNIT_STATUSES[number]
export type AiJobMode = AiJobRow['mode']

export interface AiJobRow {
  id: string
  docId: string
  initiatorUserId: number
  workspaceId: string | null
  sessionId: string | null
  mode: 'rewrite' | 'translate' | 'terminology' | 'summarise' | 'comment' | 'scan'
  status: AiJobStatus
  params: AiJobParams
  estimate: AiJobEstimate | null
  costUsd: number
  costKnown: boolean
  tokensIn: number
  tokensOut: number
  unitsTotal: number
  unitsDone: number
  unitsSkipped: number
  unitsFlagged: number
  unitsRetried: number
  workerModel: string | null
  reason: string | null
  currentHeading: string | null
  heartbeatAt: Date | null
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
}

export interface AiJobUnitRow {
  jobId: string
  ordinal: number
  headingPath: string
  startRel: string
  endRel: string
  revBefore: string
  unitTokens: number
  status: AiJobUnitStatus
  reason: string | null
  attempts: number
  beforeText: string | null
  afterHash: string | null
  sessionAfterHash: string | null
  output: AiJobUnitOutput | null
  costUsd: number
  tokensIn: number
  tokensOut: number
}

export interface NewAiJob {
  id: string
  workspaceId: string | null
  sessionId: string | null
  mode: AiJobRow['mode']
  status: 'preview' | 'awaiting_confirmation' | 'running'
  params: AiJobParams
  estimate: AiJobEstimate | null
  workerModel: string | null
  costKnown: boolean
}

export interface NewAiJobUnit {
  ordinal: number
  headingPath: string
  startRel: string
  endRel: string
  revBefore: string
  unitTokens: number
  beforeText: string
}

/** Fields of a job the engine changes. */
export type AiJobPatch = Partial<Pick<AiJobRow, 'status' | 'estimate' | 'reason' | 'currentHeading' | 'heartbeatAt' | 'finishedAt' | 'workerModel' | 'costKnown' | 'params'>>

/** Fields of a unit the engine changes. */
export type AiJobUnitPatch = Partial<Pick<AiJobUnitRow, 'status' | 'reason' | 'attempts' | 'afterHash' | 'sessionAfterHash' | 'output' | 'costUsd' | 'tokensIn' | 'tokensOut' | 'startRel' | 'endRel' | 'revBefore' | 'beforeText'>>

/** Increments of a job's counters. */
export interface AiJobProgressDelta {
  done?: number
  skipped?: number
  flagged?: number
  retried?: number
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
}

const JOB_COLUMNS = {
  id: aiJobs.id,
  docId: aiJobs.docId,
  initiatorUserId: aiJobs.initiatorUserId,
  workspaceId: aiJobs.workspaceId,
  sessionId: aiJobs.sessionId,
  mode: aiJobs.mode,
  status: aiJobs.status,
  params: aiJobs.params,
  estimate: aiJobs.estimate,
  costUsd: aiJobs.costUsd,
  costKnown: aiJobs.costKnown,
  tokensIn: aiJobs.tokensIn,
  tokensOut: aiJobs.tokensOut,
  unitsTotal: aiJobs.unitsTotal,
  unitsDone: aiJobs.unitsDone,
  unitsSkipped: aiJobs.unitsSkipped,
  unitsFlagged: aiJobs.unitsFlagged,
  unitsRetried: aiJobs.unitsRetried,
  workerModel: aiJobs.workerModel,
  reason: aiJobs.reason,
  currentHeading: aiJobs.currentHeading,
  heartbeatAt: aiJobs.heartbeatAt,
  createdAt: aiJobs.createdAt,
  updatedAt: aiJobs.updatedAt,
  finishedAt: aiJobs.finishedAt
}

const UNIT_COLUMNS = {
  jobId: aiJobUnits.jobId,
  ordinal: aiJobUnits.ordinal,
  headingPath: aiJobUnits.headingPath,
  startRel: aiJobUnits.startRel,
  endRel: aiJobUnits.endRel,
  revBefore: aiJobUnits.revBefore,
  unitTokens: aiJobUnits.unitTokens,
  status: aiJobUnits.status,
  reason: aiJobUnits.reason,
  attempts: aiJobUnits.attempts,
  beforeText: aiJobUnits.beforeText,
  afterHash: aiJobUnits.afterHash,
  sessionAfterHash: aiJobUnits.sessionAfterHash,
  output: aiJobUnits.output,
  costUsd: aiJobUnits.costUsd,
  tokensIn: aiJobUnits.tokensIn,
  tokensOut: aiJobUnits.tokensOut
}

/** Rows per INSERT when writing units (Postgres caps bind parameters at 65535). */
const UNIT_INSERT_BATCH = 500

/** Create a job and its units in one transaction, for the proof's acting user on its document. */
export async function createAiJob(doc: DocAccess<'write'>, job: NewAiJob, units: readonly NewAiJobUnit[]): Promise<AiJobRow> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(aiJobs).values({
      ...job,
      docId: doc.docId,
      initiatorUserId: proofActingUserId(doc),
      unitsTotal: units.length,
      heartbeatAt: job.status === 'running' ? new Date() : null
    }).returning(JOB_COLUMNS)
    for (let i = 0; i < units.length; i += UNIT_INSERT_BATCH) {
      await tx.insert(aiJobUnits).values(units.slice(i, i + UNIT_INSERT_BATCH).map(u => ({ ...u, jobId: job.id })))
    }
    if (!row) throw new Error('ai_jobs insert returned no row')
    return row
  })
}

/** One job of the proof's document, or null (another document's job id is null too). */
export async function getAiJobForDoc(doc: DocAccess<'view'>, jobId: string): Promise<AiJobRow | null> {
  const rows = await useDatabase().select(JOB_COLUMNS).from(aiJobs)
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.docId, doc.docId))).limit(1)
  return rows[0] ?? null
}

/** The document's jobs, newest first.
 * @public
 */
export async function listAiJobsForDoc(doc: DocAccess<'view'>, limit = 20): Promise<AiJobRow[]> {
  return useDatabase().select(JOB_COLUMNS).from(aiJobs)
    .where(eq(aiJobs.docId, doc.docId))
    .orderBy(desc(aiJobs.createdAt))
    .limit(limit)
}

/** Jobs the user started since `since` (the jobs-per-day cap). */
export async function countAiJobsSince(self: UserScope, since: Date): Promise<number> {
  const rows = await useDatabase().select({ n: sql<number>`count(*)::int` }).from(aiJobs)
    .where(and(eq(aiJobs.initiatorUserId, self.userId), gte(aiJobs.createdAt, since), inArray(aiJobs.status, ['running', 'paused_budget', 'cancelled', 'interrupted', 'done', 'failed', 'stopped_access', 'reverted'])))
  return rows[0]?.n ?? 0
}

/** Every job the user started, oldest first, without unit texts (data export). */
export async function listAiJobsForUser(self: UserScope): Promise<AiJobRow[]> {
  return useDatabase().select(JOB_COLUMNS).from(aiJobs)
    .where(eq(aiJobs.initiatorUserId, self.userId))
    .orderBy(asc(aiJobs.createdAt))
}

// ── the engine (named job) ──────────────────────────────────────────────

export async function getAiJob(_by: SystemActor, jobId: string): Promise<AiJobRow | null> {
  const rows = await useDatabase().select(JOB_COLUMNS).from(aiJobs).where(eq(aiJobs.id, jobId)).limit(1)
  return rows[0] ?? null
}

export async function updateAiJob(_by: SystemActor, jobId: string, patch: AiJobPatch): Promise<void> {
  await useDatabase().update(aiJobs).set({ ...patch, updatedAt: new Date() }).where(eq(aiJobs.id, jobId))
}

/**
 * Move a job from one of `from` to `to`; false when its status was none of
 * them (a concurrent cancel, another instance resuming it).
 */
export async function transitionAiJob(_by: SystemActor, jobId: string, from: readonly AiJobStatus[], to: AiJobStatus, patch: AiJobPatch = {}): Promise<boolean> {
  const rows = await useDatabase().update(aiJobs)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(aiJobs.id, jobId), inArray(aiJobs.status, [...from])))
    .returning({ id: aiJobs.id })
  return rows.length > 0
}

/** Add to the job's counters atomically; returns the updated row. */
export async function addAiJobProgress(_by: SystemActor, jobId: string, d: AiJobProgressDelta): Promise<AiJobRow | null> {
  const rows = await useDatabase().update(aiJobs).set({
    unitsDone: sql`${aiJobs.unitsDone} + ${d.done ?? 0}`,
    unitsSkipped: sql`${aiJobs.unitsSkipped} + ${d.skipped ?? 0}`,
    unitsFlagged: sql`${aiJobs.unitsFlagged} + ${d.flagged ?? 0}`,
    unitsRetried: sql`${aiJobs.unitsRetried} + ${d.retried ?? 0}`,
    costUsd: sql`${aiJobs.costUsd} + ${d.costUsd ?? 0}`,
    tokensIn: sql`${aiJobs.tokensIn} + ${d.tokensIn ?? 0}`,
    tokensOut: sql`${aiJobs.tokensOut} + ${d.tokensOut ?? 0}`,
    updatedAt: new Date()
  }).where(eq(aiJobs.id, jobId)).returning(JOB_COLUMNS)
  return rows[0] ?? null
}

/** Units of a job in order, optionally only those in `statuses`. */
export async function listAiJobUnits(_by: SystemActor, jobId: string, statuses?: readonly AiJobUnitStatus[]): Promise<AiJobUnitRow[]> {
  const where = statuses ? and(eq(aiJobUnits.jobId, jobId), inArray(aiJobUnits.status, [...statuses])) : eq(aiJobUnits.jobId, jobId)
  return useDatabase().select(UNIT_COLUMNS).from(aiJobUnits).where(where).orderBy(asc(aiJobUnits.ordinal))
}

/** Units of one of the proof's document's jobs (results, report). Empty for another document's job.
 * @public
 */
export async function listAiJobUnitsForDoc(doc: DocAccess<'view'>, jobId: string): Promise<AiJobUnitRow[]> {
  return useDatabase().select(UNIT_COLUMNS).from(aiJobUnits)
    .innerJoin(aiJobs, eq(aiJobs.id, aiJobUnits.jobId))
    .where(and(eq(aiJobUnits.jobId, jobId), eq(aiJobs.docId, doc.docId)))
    .orderBy(asc(aiJobUnits.ordinal))
}

/**
 * Claim up to `n` pending units (lowest ordinal first) as `running`.
 * `FOR UPDATE SKIP LOCKED` keeps two claimers from taking the same unit.
 */
export async function claimAiJobUnits(_by: SystemActor, jobId: string, n: number): Promise<AiJobUnitRow[]> {
  if (n <= 0) return []
  const db = useDatabase()
  const picked = db.select({ ordinal: aiJobUnits.ordinal }).from(aiJobUnits)
    .where(and(eq(aiJobUnits.jobId, jobId), eq(aiJobUnits.status, 'pending')))
    .orderBy(asc(aiJobUnits.ordinal))
    .limit(n)
    .for('update', { skipLocked: true })
  const rows = await db.update(aiJobUnits)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(aiJobUnits.jobId, jobId), inArray(aiJobUnits.ordinal, picked)))
    .returning(UNIT_COLUMNS)
  return rows.sort((a, b) => a.ordinal - b.ordinal)
}

export async function updateAiJobUnit(_by: SystemActor, jobId: string, ordinal: number, patch: AiJobUnitPatch): Promise<void> {
  await useDatabase().update(aiJobUnits).set({ ...patch, updatedAt: new Date() })
    .where(and(eq(aiJobUnits.jobId, jobId), eq(aiJobUnits.ordinal, ordinal)))
}

/** Put `running` units back to `pending` (resume after a stop or a crash); returns how many. */
export async function requeueRunningAiJobUnits(_by: SystemActor, jobId: string): Promise<number> {
  const rows = await useDatabase().update(aiJobUnits).set({ status: 'pending', updatedAt: new Date() })
    .where(and(eq(aiJobUnits.jobId, jobId), eq(aiJobUnits.status, 'running')))
    .returning({ ordinal: aiJobUnits.ordinal })
  return rows.length
}

/** Put the listed units back to `pending` (rerun of skipped / flagged units). */
export async function requeueAiJobUnits(_by: SystemActor, jobId: string, ordinals: readonly number[]): Promise<number> {
  if (ordinals.length === 0) return 0
  const rows = await useDatabase().update(aiJobUnits).set({ status: 'pending', reason: null, updatedAt: new Date() })
    .where(and(eq(aiJobUnits.jobId, jobId), inArray(aiJobUnits.ordinal, [...ordinals])))
    .returning({ ordinal: aiJobUnits.ordinal })
  return rows.length
}

// ── sweeper ─────────────────────────────────────────────────────────────

/**
 * Mark `running` jobs whose heartbeat is older than `staleBefore` (their
 * instance died) as `interrupted`, and put their running units back to
 * pending. Returns the job ids.
 */
export async function markStaleAiJobsInterrupted(_by: SystemActor, staleBefore: Date): Promise<string[]> {
  const db = useDatabase()
  return db.transaction(async (tx) => {
    const rows = await tx.update(aiJobs)
      .set({ status: 'interrupted', reason: 'The server running the job stopped. Resume the job to continue.', updatedAt: new Date() })
      .where(and(eq(aiJobs.status, 'running'), sql`coalesce(${aiJobs.heartbeatAt}, ${aiJobs.updatedAt}) < ${staleBefore}`))
      .returning({ id: aiJobs.id })
    const ids = rows.map(r => r.id)
    if (ids.length > 0) {
      await tx.update(aiJobUnits).set({ status: 'pending', updatedAt: new Date() })
        .where(and(inArray(aiJobUnits.jobId, ids), eq(aiJobUnits.status, 'running')))
    }
    return ids
  })
}

/** Drop the before texts of jobs created before `before` (undo window over); returns the units purged. */
export async function purgeAiJobBeforeTexts(_by: SystemActor, before: Date): Promise<number> {
  const old = useDatabase().select({ id: aiJobs.id }).from(aiJobs).where(lt(aiJobs.createdAt, before))
  const rows = await useDatabase().update(aiJobUnits).set({ beforeText: null, updatedAt: new Date() })
    .where(and(isNotNull(aiJobUnits.beforeText), inArray(aiJobUnits.jobId, old)))
    .returning({ jobId: aiJobUnits.jobId })
  return rows.length
}

/** Delete jobs (with their units) created before `before` that are no longer running. */
export async function deleteOldAiJobs(_by: SystemActor, before: Date): Promise<number> {
  const rows = await useDatabase().delete(aiJobs)
    .where(and(lt(aiJobs.createdAt, before), sql`${aiJobs.status} <> 'running'`))
    .returning({ id: aiJobs.id })
  return rows.length
}
