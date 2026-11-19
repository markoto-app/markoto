import jwt from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import {
  addAiJobProgress,
  claimAiJobUnits,
  createAiJob,
  getAiJob,
  getAiJobForDoc,
  listAiJobsForDoc,
  listAiJobUnits,
  requeueAiJobUnits,
  requeueRunningAiJobUnits,
  transitionAiJob,
  updateAiJob,
  updateAiJobUnit,
  type AiJobParams,
  type AiJobRow,
  type AiJobStatus
} from '../../../repos/aiJobs'
import { appendActivity } from '../../../repos/activity'
import { appendAuditEvent } from '../../../repos/audit'
import { proofActingUserId, system, type DocAccess } from '../../../repos/proofs'
import { findUserName } from '../../../repos/users'
import { proveDocMembership } from '../../access/docProof'
import { canEditDoc } from '../../access/workspaceAccess'
import { resolveBillingContext } from '../../billing/billing'
import { resolveAiProviders, workerProviderFor, isPlatformBilled, type ResolvedAiProvider, type ResolvedAiProviders } from '../../aiProviders/resolve'
import { providerRequestFields, withProviderErrors } from '../../aiProviders/requestFields'
import { litellmCompletion } from '../../litellm/createCompletion'
import { modelRequestParams } from '../../litellm/modelParams'
import { FEATURE_TAGS, featureMetadata } from '../../litellm/featureTags'
import { isBudgetExceededError, LitellmBudgetExhausted } from '../../litellm/userKeys'
import { isFreeAllowanceExhaustedError } from '../../litellm/freeTierTeam'
import { isWorkspaceTeamBudgetError } from '../../litellm/workspaceTeams'
import { workerPrice } from '../../litellm/workerPrices'
import { useLitellmForUser } from '../litellmClient'
import { checkout, release } from '../../mcp/yDocPool'
import { useValkey, useValkeySubscriber } from '../../platform/valkey'
import { useLogger } from '../../platform/logger'
import { apiError } from '../../api/apiError'
import { buildCallUsageRecord, CALL_USAGE_EVENT } from '../../agentic/loop/callUsage'
import { AUDIT_AI_JOB_REVERTED, AUDIT_AI_JOB_STARTED } from '../../../legal/auditActions'
import { buildJobUnits, type JobMode, type JobTargets, type JobUnit, type SplitOptions } from './units'
import { buildJobPart, WORKER_SYSTEM_PROMPT } from './workerPrompt'
import { callCostUsd, estimateJob, type JobEstimate } from './estimate'
import { jobSpecOf, newUnitRows, progressOf, JobRunner, type PreviewSample } from './runner'
import { revertJobUnits, type RevertResult } from './revert'
import type { FollowUpStore } from './followUps'
import { assertJobAllowed } from './jobLimits'
import { languageCode } from './validate'
import { regexSafetyProblem } from '../tools/sections/search'
import type { JobDocHandles, JobProgress, JobStore, WorkerCall } from './jobTypes'
import { aiJobClientUserId, type SessionJwtPayload } from '~~/shared/contracts/jwt'
import { useEnv } from '~~/shared/env/load'
import { MINUTE_MS, SECOND_MS } from '~~/shared/config/units'
import type { PlanName } from '~~/shared/config/tiers'

// Production wiring of the job engine: persistence through the repos, the
// worker through LiteLLM on the initiator's virtual key, the document
// through a YDocPool connection of its own (principal `ai-job:<id>`, a
// token-minting function, so it outlives JWTs and the 5-minute AI
// session), one running job per user and per document (Valkey `SET NX`,
// fail closed), progress over Valkey pub/sub. The functions below are what
// the planner's tools and the UI call.

const log = useLogger('ai-jobs')
const JOBS = system('ai-jobs')

/** Locks expire unless the running instance refreshes them (heartbeat). */
const LOCK_TTL_MS = 2 * MINUTE_MS
const HEARTBEAT_MS = 30 * SECOND_MS
const JOB_JWT_TTL = '10m'

// ── store ──────────────────────────────────────────────────────────────

function repoJobStore(jobId: string): JobStore {
  return {
    getJob: () => getAiJob(JOBS, jobId),
    update: patch => updateAiJob(JOBS, jobId, patch),
    transition: (from, to, patch) => transitionAiJob(JOBS, jobId, from, to, patch),
    addProgress: delta => addAiJobProgress(JOBS, jobId, delta),
    claimUnits: n => claimAiJobUnits(JOBS, jobId, n),
    updateUnit: (ordinal, patch) => updateAiJobUnit(JOBS, jobId, ordinal, patch),
    listUnits: statuses => listAiJobUnits(JOBS, jobId, statuses),
    requeueRunning: () => requeueRunningAiJobUnits(JOBS, jobId)
  }
}

/** The parts a job's AI session may still correct as part of the job (`followUps.ts`). */
export const jobFollowUpStore = (jobId: string): FollowUpStore => ({
  listUnits: () => listAiJobUnits(JOBS, jobId, ['applied', 'flagged']),
  saveSessionHash: (ordinal, hash) => updateAiJobUnit(JOBS, jobId, ordinal, { sessionAfterHash: hash })
})

// ── locks ──────────────────────────────────────────────────────────────

const userLockKey = (userId: number) => `ai:job-lock:user:${userId}`
const docLockKey = (docId: string) => `ai:job-lock:doc:${docId}`

const RELEASE_IF_OWNER = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'
const REFRESH_IF_OWNER = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end'

/** Take the per-user and per-document job locks for `jobId`. Fails closed: false when Valkey errs. */
async function acquireJobLocks(jobId: string, userId: number, docId: string): Promise<boolean> {
  const valkey = useValkey()
  try {
    const user = await valkey.set(userLockKey(userId), jobId, 'PX', LOCK_TTL_MS, 'NX')
    if (user !== 'OK' && (await valkey.get(userLockKey(userId))) !== jobId) return false
    const doc = await valkey.set(docLockKey(docId), jobId, 'PX', LOCK_TTL_MS, 'NX')
    if (doc !== 'OK' && (await valkey.get(docLockKey(docId))) !== jobId) {
      await valkey.eval(RELEASE_IF_OWNER, 1, userLockKey(userId), jobId)
      return false
    }
    await valkey.pexpire(userLockKey(userId), LOCK_TTL_MS)
    await valkey.pexpire(docLockKey(docId), LOCK_TTL_MS)
    return true
  } catch (e) {
    log.warn('job lock unavailable', { err: e, jobId })
    return false
  }
}

async function refreshJobLocks(jobId: string, userId: number, docId: string): Promise<boolean> {
  try {
    const valkey = useValkey()
    const a = await valkey.eval(REFRESH_IF_OWNER, 1, userLockKey(userId), jobId, String(LOCK_TTL_MS))
    const b = await valkey.eval(REFRESH_IF_OWNER, 1, docLockKey(docId), jobId, String(LOCK_TTL_MS))
    return a === 1 && b === 1
  } catch (e) {
    log.warn('job lock refresh failed', { err: e, jobId })
    return false
  }
}

async function releaseJobLocks(jobId: string, userId: number, docId: string): Promise<void> {
  try {
    const valkey = useValkey()
    await valkey.eval(RELEASE_IF_OWNER, 1, userLockKey(userId), jobId)
    await valkey.eval(RELEASE_IF_OWNER, 1, docLockKey(docId), jobId)
  } catch (e) {
    log.warn('job lock release failed', { err: e, jobId })
  }
}

// ── progress ───────────────────────────────────────────────────────────

const progressChannel = (jobId: string) => `ai:job:${jobId}:progress`
const progressListeners = new Map<string, Set<(p: JobProgress) => void>>()
let progressHandlerOn: ReturnType<typeof useValkeySubscriber> | null = null

function publishJobProgress(progress: JobProgress): void {
  useValkey().publish(progressChannel(progress.jobId), JSON.stringify(progress)).catch((e: unknown) => log.warn('progress publish failed', { err: e }))
}

/** The job's progress as stored (also right after a restart), or null when there is no such job.
 * @public
 */
export async function getJobProgress(jobId: string): Promise<JobProgress | null> {
  const row = await getAiJob(JOBS, jobId)
  return row ? progressOf(row) : null
}

/**
 * Call `listener` with every progress update of `jobId` (any instance).
 * Resolves to the unsubscribe function. The caller checks that the
 * subscriber may see the job (the initiator).
 * @public
 */
export async function subscribeJobProgress(jobId: string, listener: (p: JobProgress) => void): Promise<() => void> {
  const sub = useValkeySubscriber()
  if (progressHandlerOn !== sub) {
    progressHandlerOn = sub
    sub.on('message', (channel: string, message: string) => {
      const set = progressListeners.get(channel)
      if (!set) return
      let parsed: JobProgress
      try {
        parsed = JSON.parse(message) as JobProgress
      } catch {
        return
      }
      for (const l of set) {
        try {
          l(parsed)
        } catch (e) {
          log.warn('progress listener failed', { err: e })
        }
      }
    })
  }
  const channel = progressChannel(jobId)
  let set = progressListeners.get(channel)
  if (!set) {
    set = new Set()
    progressListeners.set(channel, set)
    try {
      await sub.subscribe(channel)
    } catch (e) {
      progressListeners.delete(channel)
      throw e
    }
  }
  set.add(listener)
  return () => {
    const current = progressListeners.get(channel)
    if (!current) return
    current.delete(listener)
    if (current.size > 0) return
    progressListeners.delete(channel)
    sub.unsubscribe(channel).catch((e: unknown) => log.warn('progress unsubscribe failed', { err: e }))
  }
}

// ── worker ─────────────────────────────────────────────────────────────

export interface JobBilling {
  virtualKey: string
  providers: ResolvedAiProviders
  workspaceId: string | null
  userId: number
  docId: string
}

function isJobBudgetError(e: unknown): boolean {
  return e instanceof LitellmBudgetExhausted || isBudgetExceededError(e) || isFreeAllowanceExhaustedError(e) || isWorkspaceTeamBudgetError(e)
}

function escalatedProvider(providers: ResolvedAiProviders, normal: ResolvedAiProvider): ResolvedAiProvider {
  const strong = workerProviderFor(providers, { strong: true })
  if (strong && strong.model !== normal.model) return strong
  return providers.chat ?? normal
}

/** The worker call of a job on the initiator's LiteLLM key, tagged `feature:delegate-rewrite` + `job:<id>`. */
function litellmWorkerCall(job: Pick<AiJobRow, 'id' | 'mode' | 'sessionId'>, billing: JobBilling): WorkerCall {
  const normal = workerProviderFor(billing.providers, job.mode)
  if (!normal) throw apiError('ai/provider-missing', { capability: 'chat' })
  const litellm = useLitellmForUser(billing.virtualKey)
  const { metadata } = featureMetadata(FEATURE_TAGS.delegateRewrite, { workspaceId: billing.workspaceId, userId: billing.userId, docId: billing.docId })
  let calls = 0
  return async (req) => {
    const provider = req.escalated ? escalatedProvider(billing.providers, normal) : normal
    const fields = await providerRequestFields(provider)
    const startedAt = Date.now()
    const resp = await withProviderErrors(provider, () => litellmCompletion(litellm, {
      ...fields,
      messages: req.messages,
      ...modelRequestParams(fields.model, { temperature: req.temperature, purpose: 'worker' }),
      max_tokens: req.maxTokens,
      prompt_cache_key: req.cacheKey,
      metadata: { tags: [...metadata.tags, `job:${job.id}`] }
    }, { signal: req.signal }))
    const endedAt = Date.now()
    const usage = {
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      cachedTokens: resp.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0
    }
    log.info(CALL_USAGE_EVENT, { ...buildCallUsageRecord({
      sessionId: job.sessionId ?? job.id,
      docId: billing.docId,
      turn: ++calls,
      phase: 'job',
      jobId: job.id,
      requestedModel: fields.model,
      providerModel: resp.model ?? null,
      usage: { promptTokenCount: usage.promptTokens, cachedContentTokenCount: usage.cachedTokens, candidatesTokenCount: usage.outputTokens },
      startedAt,
      endedAt,
      finishReason: resp.choices?.[0]?.finish_reason ?? null
    }) })
    const costUsd = isPlatformBilled(provider) ? callCostUsd(workerPrice(provider.model), usage) : null
    return { text: resp.choices?.[0]?.message?.content ?? '', model: fields.model, usage, costUsd, latencyMs: endedAt - startedAt }
  }
}

async function resolveJobBilling(job: AiJobRow): Promise<{ billing: JobBilling, plan: PlanName }> {
  const ctx = await resolveBillingContext(job.initiatorUserId, job.workspaceId)
  const providers = await resolveAiProviders(JOBS.actingFor(job.initiatorUserId), ctx.plan)
  return { billing: { virtualKey: ctx.virtualKey, providers, workspaceId: job.workspaceId, userId: job.initiatorUserId, docId: job.docId }, plan: ctx.plan }
}

// ── document connection ────────────────────────────────────────────────

function mintJobJwt(docId: string, jobId: string): string {
  const secret = useEnv().auth.jwtSecret
  if (!secret) throw new Error('JWT secret not configured')
  const payload: SessionJwtPayload = { docId, userId: aiJobClientUserId(jobId), userName: 'markoto', readOnly: false }
  return jwt.sign(payload, secret, { expiresIn: JOB_JWT_TTL })
}

interface JobConnection {
  doc: JobDocHandles
  setCursor: (index: number | null) => void
  close: () => void
}

/**
 * The job's own connection. Awareness shows only the AI presence with the
 * phase `job` (no instruction, no progress: those go to the initiator).
 */
async function connectJobDoc(job: AiJobRow): Promise<JobConnection> {
  const initiatorName = (await findUserName(JOBS.actingFor(job.initiatorUserId))) ?? ''
  const key = { docId: job.docId, principalId: aiJobClientUserId(job.id) }
  const entry = await checkout(key, {
    jwt: () => mintJobJwt(job.docId, job.id),
    awarenessUser: { name: 'markoto', color: '#d97706', isAI: true },
    awarenessExtra: {
      aiSession: { sessionId: job.id, initiatorName, initiatorUserId: job.initiatorUserId },
      aiStatus: { phase: 'job', message: null }
    },
    syncUrl: useEnv().sync.internalUrl.replace(/^http(s?):\/\//, 'ws$1://')
  })
  return {
    doc: { ydoc: entry.ydoc, ytext: entry.ytext },
    setCursor: (index) => {
      try {
        if (index === null) {
          entry.awareness.setLocalStateField('cursor', null)
          return
        }
        const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(entry.ytext, index))
        entry.awareness.setLocalStateField('cursor', { anchor: rel, head: rel })
      } catch { /* presence is best-effort */ }
    },
    close: () => {
      try {
        entry.awareness.setLocalState(null)
      } catch { /* best-effort */ }
      release(key)
    }
  }
}

// ── activity ───────────────────────────────────────────────────────────

async function logJobActivity(doc: DocAccess<'write'>, job: AiJobRow, phase: 'started' | 'finished'): Promise<void> {
  try {
    await appendActivity(doc, {
      userId: job.initiatorUserId,
      userName: null,
      actorPrincipal: aiJobClientUserId(job.id),
      action: 'ai.job',
      metadata: { kind: 'ai.job', jobId: job.id, mode: job.mode, phase, status: job.status, unitsTotal: job.unitsTotal, done: job.unitsDone, skipped: job.unitsSkipped, flagged: job.unitsFlagged }
    })
  } catch (e) {
    log.warn('job activity row failed', { err: e, jobId: job.id })
  }
}

// ── running jobs of this process ───────────────────────────────────────

const running = new Map<string, JobRunner>()
const shutdown = new AbortController()

/** Stop every job of this process (shutdown): they become `interrupted` and resume elsewhere. */
export function stopAllJobs(): void {
  shutdown.abort()
}

/** Run a job that is already `running` and whose locks are held, in the background. */
function launch(jobId: string): void {
  void runInBackground(jobId).catch((e: unknown) => log.error('job run failed', { err: e, jobId }))
}

async function runInBackground(jobId: string): Promise<void> {
  const store = repoJobStore(jobId)
  const job = await store.getJob()
  if (!job || job.status !== 'running') return
  const release = () => releaseJobLocks(jobId, job.initiatorUserId, job.docId)
  let conn: JobConnection | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  try {
    const member = await proveDocMembership(job.initiatorUserId, job.docId, 'edit')
    if (!member) {
      await store.transition(['running'], 'stopped_access', { reason: 'The person who started the job can no longer edit this document.', finishedAt: new Date() })
      return
    }
    const { billing } = await resolveJobBilling(job)
    if (!billing.providers.worker) {
      await store.transition(['running'], 'failed', { reason: 'No AI provider is set up.', finishedAt: new Date() })
      return
    }
    conn = await connectJobDoc(job)
    const runner = new JobRunner({
      jobId,
      store,
      doc: conn.doc,
      worker: litellmWorkerCall(job, billing),
      canEdit: () => canEditDoc(job.initiatorUserId, job.docId),
      isBudgetError: isJobBudgetError,
      publish: publishJobProgress,
      onCursor: conn.setCursor,
      signal: shutdown.signal
    })
    running.set(jobId, runner)
    heartbeat = setInterval(() => {
      void (async () => {
        await updateAiJob(JOBS, jobId, { heartbeatAt: new Date() })
        if (!(await refreshJobLocks(jobId, job.initiatorUserId, job.docId))) runner.halt('aborted')
      })().catch((e: unknown) => log.warn('job heartbeat failed', { err: e, jobId }))
    }, HEARTBEAT_MS)
    await store.update({ heartbeatAt: new Date() })
    const result = await runner.run()
    log.info('job finished', { jobId, status: result.status, done: result.done, skipped: result.skipped, flagged: result.flagged })
    const final = await store.getJob()
    if (final) await logJobActivity(member.access, final, 'finished')
  } catch (e) {
    // No connection, a store error: the job can be resumed; nothing was lost.
    log.error('job stopped by an error', { err: e, jobId })
    await store.requeueRunning().catch(() => 0)
    await store.transition(['running'], 'interrupted', { reason: 'The job stopped because of a server error. Resume it to continue.', currentHeading: null }).catch(() => false)
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    running.delete(jobId)
    conn?.close()
    await release()
  }
}

// ── public API (the planner's tools and the UI) ────────────────────────

export interface CreateJobInput {
  /** The initiator's write proof on the document. */
  doc: DocAccess<'write'>
  /** The document's text as the planner sees it (its session's Y.Text: same items as every other connection). */
  ytext: Y.Text
  mode: JobMode
  params: AiJobParams
  targets: JobTargets
  workspaceId: string | null
  sessionId: string | null
  plan: PlanName
  providers: ResolvedAiProviders
}

export interface CreatedJob {
  job: AiJobRow
  units: JobUnit[]
  estimate: JobEstimate
}

/** The `only_matching` pattern as a RegExp; refused like `search_document`'s patterns when it could backtrack badly. */
function onlyMatchingRegExp(pattern: string | null | undefined): RegExp | null {
  if (!pattern) return null
  const problem = regexSafetyProblem(pattern)
  if (problem) throw new Error(problem)
  // eslint-disable-next-line security/detect-non-literal-regexp -- planner input, checked by regexSafetyProblem (length, no backreferences, no nested repetition)
  return new RegExp(pattern, 'u')
}

/**
 * Split the targets into units, estimate the job and store it with status
 * `preview` (nothing runs yet). Refuses with 409 `plan/limit-reached` when
 * the job has more units than the plan allows.
 * @public
 */
export async function createJob(input: CreateJobInput): Promise<CreatedJob> {
  const split: SplitOptions = {
    mode: input.mode,
    granularity: input.params.granularity ?? 'auto',
    onlyMatching: onlyMatchingRegExp(input.params.onlyMatching)
  }
  const units = buildJobUnits(input.ytext.toString(), input.targets, split)
  const self = JOBS.actingFor(proofActingUserId(input.doc))
  await assertJobAllowed(self, input.plan, units.length)
  const worker = workerProviderFor(input.providers, input.mode)
  if (!worker) throw apiError('ai/provider-missing', { capability: 'chat' })
  const sourceLanguage = input.params.sourceLanguage ?? null
  const estimate = estimateJob({
    mode: input.mode,
    unitTokens: units.map(u => u.tokens),
    systemChars: WORKER_SYSTEM_PROMPT.length,
    jobChars: buildJobPart(jobSpecOf({ mode: input.mode, params: input.params })).length,
    price: isPlatformBilled(worker) ? workerPrice(worker.model) : null,
    sourceLanguage,
    targetLanguage: languageCode(input.params.targetLanguage)
  })
  const job = await createAiJob(input.doc, {
    id: `j-${nanoid(12)}`,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    mode: input.mode,
    status: 'preview',
    params: input.params,
    estimate,
    workerModel: worker.model,
    costKnown: isPlatformBilled(worker) ? workerPrice(worker.model) !== null : false
  }, newUnitRows(input.ytext, units))
  return { job, units, estimate }
}

async function requireJob(doc: DocAccess<'view'>, jobId: string): Promise<AiJobRow> {
  const job = await getAiJobForDoc(doc, jobId)
  if (!job) throw apiError('ai/job-not-found')
  return job
}

/**
 * Run the worker on some units without applying anything (the planner's
 * preview). The job must not be running. Stores the samples on the units.
 * @public
 */
export async function previewJob(doc: DocAccess<'write'>, jobId: string, ordinals: readonly number[]): Promise<PreviewSample[]> {
  const job = await requireJob(doc, jobId)
  if (job.status === 'running') throw apiError('ai/job-state', { status: job.status })
  const { billing } = await resolveJobBilling(job)
  const conn = await connectJobDoc(job)
  try {
    return await new JobRunner({
      jobId,
      store: repoJobStore(jobId),
      doc: conn.doc,
      worker: litellmWorkerCall(job, billing),
      canEdit: () => canEditDoc(job.initiatorUserId, job.docId),
      isBudgetError: isJobBudgetError,
      publish: () => undefined
    }).preview(ordinals)
  } finally {
    conn.close()
  }
}

/** The job waits for the user's confirmation of the estimate.
 * @public
 */
export async function awaitConfirmation(doc: DocAccess<'write'>, jobId: string): Promise<void> {
  await requireJob(doc, jobId)
  if (!(await transitionAiJob(JOBS, jobId, ['preview'], 'awaiting_confirmation'))) throw apiError('ai/job-state')
}

const STARTABLE: readonly AiJobStatus[] = ['preview', 'awaiting_confirmation']
const RESUMABLE: readonly AiJobStatus[] = ['interrupted', 'paused_budget', 'cancelled', 'stopped_access', 'done', 'failed']

/**
 * Start (or resume) a job for its initiator: daily cap, one running job
 * per user and per document (409 `ai/job-busy`), then it runs in the
 * background. `actorIp` goes to the audit row (truncated there).
 * @public
 */
export async function startJob(doc: DocAccess<'write'>, jobId: string, actorIp: string | null = null): Promise<AiJobRow> {
  const job = await requireJob(doc, jobId)
  const resumed = RESUMABLE.includes(job.status)
  if (!resumed && !STARTABLE.includes(job.status)) throw apiError('ai/job-state', { status: job.status })
  if (!resumed) {
    const { plan } = await resolveJobBilling(job)
    await assertJobAllowed(JOBS.actingFor(job.initiatorUserId), plan, job.unitsTotal)
  }
  if (!(await acquireJobLocks(jobId, job.initiatorUserId, job.docId))) throw apiError('ai/job-busy')
  try {
    await requeueRunningAiJobUnits(JOBS, jobId)
    const from = resumed ? RESUMABLE : STARTABLE
    if (!(await transitionAiJob(JOBS, jobId, from, 'running', { reason: null, finishedAt: null, heartbeatAt: new Date() }))) throw apiError('ai/job-state')
  } catch (e) {
    await releaseJobLocks(jobId, job.initiatorUserId, job.docId)
    throw e
  }
  const started = (await getAiJob(JOBS, jobId)) ?? job
  await appendAuditEvent({
    by: doc,
    actorIp,
    scope: 'doc',
    scopeId: job.docId,
    workspaceId: job.workspaceId,
    action: AUDIT_AI_JOB_STARTED,
    metadata: { jobId, mode: job.mode, units: job.unitsTotal, resumed }
  })
  if (!resumed) await logJobActivity(doc, started, 'started')
  launch(jobId)
  return started
}

/** Run the listed units again (after a skip or a glossary flag), optionally with an amended instruction.
 * @public
 */
export async function rerunJobUnits(doc: DocAccess<'write'>, jobId: string, ordinals: readonly number[], instructionPatch?: string): Promise<AiJobRow> {
  const job = await requireJob(doc, jobId)
  if (job.status === 'running') throw apiError('ai/job-state', { status: job.status })
  if (instructionPatch?.trim()) {
    await updateAiJob(JOBS, jobId, { params: { ...job.params, instruction: `${job.params.instruction}\n${instructionPatch.trim()}` } })
  }
  const units = await listAiJobUnits(JOBS, jobId)
  // Rerun units whose text the job has not changed: their revision is still the one at job start.
  const rerunnable = units.filter(u => ordinals.includes(u.ordinal) && (u.status === 'skipped' || u.status === 'failed' || u.status === 'flagged'))
  // A flagged unit was applied: its current text is the job's output (or this session's correction of it), so its revision moves with it.
  for (const u of rerunnable.filter(x => x.status === 'flagged')) {
    const rev = u.sessionAfterHash ?? u.afterHash
    if (rev) await updateAiJobUnit(JOBS, jobId, u.ordinal, { revBefore: rev })
  }
  await requeueAiJobUnits(JOBS, jobId, rerunnable.map(u => u.ordinal))
  return startJob(doc, jobId)
}

/** Cancel: stops dispatching; results still in flight are discarded.
 * @public
 */
/** Every part of a running job is through; only its final checks are left. */
export function jobIsFinishing(job: Pick<AiJobRow, 'status' | 'unitsDone' | 'unitsSkipped' | 'unitsTotal'>): boolean {
  return job.status === 'running' && job.unitsTotal > 0 && job.unitsDone + job.unitsSkipped >= job.unitsTotal
}

/**
 * Cancel a job. A job whose parts are all done is left to finish (its
 * status becomes `done` a moment later): a Cancel clicked in that window
 * used to mark a complete job "cancelled after 8 of 8 parts" and the
 * planner reported it as cancelled. `force` (undo) cancels regardless.
 */
export async function cancelJob(doc: DocAccess<'write'>, jobId: string, opts: { force?: boolean } = {}): Promise<AiJobRow> {
  const job = await requireJob(doc, jobId)
  if (!opts.force && jobIsFinishing(job)) return job
  const ok = await transitionAiJob(JOBS, jobId, ['preview', 'awaiting_confirmation', 'running', 'paused_budget', 'interrupted'], 'cancelled', { currentHeading: null })
  if (!ok) throw apiError('ai/job-state', { status: job.status })
  running.get(jobId)?.halt('cancelled')
  const row = (await getAiJob(JOBS, jobId)) ?? job
  publishJobProgress(progressOf(row))
  return row
}

/**
 * "Undo job": restore every unit the job wrote that nobody changed since.
 * A running job is cancelled first.
 * @public
 */
export async function revertJob(doc: DocAccess<'write'>, jobId: string, actorIp: string | null = null): Promise<RevertResult> {
  let job = await requireJob(doc, jobId)
  if (job.status === 'running') job = await cancelJob(doc, jobId, { force: true })
  if (job.status === 'reverted') throw apiError('ai/job-state', { status: job.status })
  if (!(await acquireJobLocks(jobId, job.initiatorUserId, job.docId))) throw apiError('ai/job-busy')
  const conn = await connectJobDoc(job).catch(async (e: unknown) => {
    await releaseJobLocks(jobId, job.initiatorUserId, job.docId)
    throw e
  })
  try {
    const result = await revertJobUnits({ jobId, store: repoJobStore(jobId), doc: conn.doc })
    try {
      await appendActivity(doc, {
        userId: job.initiatorUserId,
        userName: null,
        actorPrincipal: aiJobClientUserId(job.id),
        action: 'ai.job.reverted',
        metadata: { kind: 'ai.job.reverted', jobId, mode: job.mode, reverted: result.reverted, followUps: result.followUps, skipped: result.skipped.length }
      })
    } catch (e) {
      log.warn('job revert activity row failed', { err: e, jobId })
    }
    await appendAuditEvent({
      by: doc,
      actorIp,
      scope: 'doc',
      scopeId: job.docId,
      workspaceId: job.workspaceId,
      action: AUDIT_AI_JOB_REVERTED,
      metadata: { jobId, mode: job.mode, reverted: result.reverted, skipped: result.skipped.length }
    })
    return result
  } finally {
    conn.close()
    await releaseJobLocks(jobId, job.initiatorUserId, job.docId)
  }
}

/** Comment-mode findings of a job, per unit, for turning into draft comments (the quote is exact text of the unit).
 * @public
 */
export async function listJobFindings(doc: DocAccess<'view'>, jobId: string): Promise<Array<{ ordinal: number, headingPath: string, startRel: string, endRel: string, findings: Array<{ quote: string, issue: string, suggestion?: string, severity: 'low' | 'medium' | 'high' }> }>> {
  await requireJob(doc, jobId)
  const units = await listAiJobUnits(JOBS, jobId, ['applied'])
  return units.flatMap(u => (u.output?.kind === 'comments' && u.output.findings.length > 0
    ? [{ ordinal: u.ordinal, headingPath: u.headingPath, startRel: u.startRel, endRel: u.endRel, findings: u.output.findings }]
    : []))
}

/** One item a scan chunk reported, with the chunk it came from. */
export interface ScanChunkItem {
  text: string
  example?: string
  ordinal: number
  headingPath: string
}

export interface ScanRun {
  job: AiJobRow
  /** Worker calls (chunks of about 15k tokens). */
  chunks: number
  /** Chunks whose answer failed the checks or the call. */
  failedChunks: number
  items: ScanChunkItem[]
}

/** The items of one scan chunk's preview answer (JSON written by `structuredOutput`). */
function scanItemsOf(after: string): Array<{ text: string, example?: string }> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(after)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return (parsed as Array<{ text?: unknown, example?: unknown }>).flatMap(item => (typeof item.text === 'string' && item.text.trim() !== ''
    ? [{ text: item.text, ...(typeof item.example === 'string' ? { example: item.example } : {}) }]
    : []))
}

/**
 * A read-only scan (`delegate_scan`): split the targets into large chunks,
 * run the worker on each in scan mode and return what they reported.
 * Nothing is applied and nothing runs in the background: it uses the
 * preview path, so it needs no job lock and does not count as a started
 * job. The job row keeps the cost; the sweeper removes it.
 * @public
 */
export async function scanDocument(input: Omit<CreateJobInput, 'mode'>): Promise<ScanRun> {
  const created = await createJob({ ...input, mode: 'scan' })
  const samples = await previewJob(input.doc, created.job.id, created.units.map(u => u.ordinal))
  const items: ScanChunkItem[] = []
  let failedChunks = created.units.length - samples.length
  for (const s of samples) {
    const parsed = s.ok ? scanItemsOf(s.after) : null
    if (!parsed) {
      failedChunks += 1
      continue
    }
    for (const item of parsed) items.push({ ...item, ordinal: s.ordinal, headingPath: s.headingPath })
  }
  const job = (await getAiJob(JOBS, created.job.id)) ?? created.job
  return { job, chunks: created.units.length, failedChunks, items }
}

/** A skipped, failed or flagged unit of a job, for the planner's and the user's report. */
export interface JobUnitNote {
  ordinal: number
  headingPath: string
  status: 'skipped' | 'failed' | 'flagged'
  reason: string | null
}

export interface JobReport {
  job: AiJobRow
  notes: JobUnitNote[]
}

/**
 * The job and its units that need attention (skipped, failed, flagged),
 * in document order; at most `limit` notes.
 * @public
 */
export async function getJobReport(doc: DocAccess<'view'>, jobId: string, limit = 40): Promise<JobReport> {
  const job = await requireJob(doc, jobId)
  const units = await listAiJobUnits(JOBS, jobId, ['skipped', 'failed', 'flagged'])
  const notes = units.slice(0, limit).map(u => ({ ordinal: u.ordinal, headingPath: u.headingPath, status: u.status as JobUnitNote['status'], reason: u.reason }))
  return { job, notes }
}

/**
 * The document's recent jobs (newest first), without scans.
 * @public
 */
export async function listDocJobs(doc: DocAccess<'view'>, limit = 20): Promise<AiJobRow[]> {
  return (await listAiJobsForDoc(doc, limit + 10)).filter(j => j.mode !== 'scan').slice(0, limit)
}
