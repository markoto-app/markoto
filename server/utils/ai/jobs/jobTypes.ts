import type * as Y from 'yjs'
import type { AiJobPatch, AiJobProgressDelta, AiJobRow, AiJobStatus, AiJobUnitPatch, AiJobUnitRow, AiJobUnitStatus } from '../../../repos/aiJobs'
import type { WorkerMessage } from './workerPrompt'

// The seams of the job runner: persistence, the worker call and the
// document. Production wires them to the repos, LiteLLM and a YDocPool
// connection (`engine.ts`); tests inject an in-memory store, a fake worker
// and a plain Y.Doc.

/** Persistence of ONE job and its units. */
export interface JobStore {
  getJob(): Promise<AiJobRow | null>
  update(patch: AiJobPatch): Promise<void>
  /** Status change only from one of `from`; false when the job was in none of them. */
  transition(from: readonly AiJobStatus[], to: AiJobStatus, patch?: AiJobPatch): Promise<boolean>
  addProgress(delta: AiJobProgressDelta): Promise<AiJobRow | null>
  claimUnits(n: number): Promise<AiJobUnitRow[]>
  updateUnit(ordinal: number, patch: AiJobUnitPatch): Promise<void>
  listUnits(statuses?: readonly AiJobUnitStatus[]): Promise<AiJobUnitRow[]>
  requeueRunning(): Promise<number>
}

export interface WorkerCallRequest {
  messages: WorkerMessage[]
  temperature: number
  maxTokens: number
  /** The escalation step of the retry ladder: the strong worker, else the chat model. */
  escalated: boolean
  /** `prompt_cache_key`: one per job, so the provider routes its calls to one cache. */
  cacheKey: string
  signal: AbortSignal
}

export interface WorkerCallUsage {
  promptTokens: number
  cachedTokens: number
  outputTokens: number
}

export interface WorkerCallResult {
  text: string
  /** Model the call named (LiteLLM alias or `byok/...`). */
  model: string
  usage: WorkerCallUsage
  /** USD charged to the platform budget; null when unknown (own key without a known price). */
  costUsd: number | null
  latencyMs: number
}

export type WorkerCall = (req: WorkerCallRequest) => Promise<WorkerCallResult>

/** What the initiator's progress bar shows (and the SSE route streams). */
export interface JobProgress {
  jobId: string
  status: AiJobStatus
  done: number
  skipped: number
  flagged: number
  total: number
  currentHeading: string | null
  costUsd: number
  costKnown: boolean
}

export interface JobDocHandles {
  ydoc: Y.Doc
  ytext: Y.Text
}

export interface JobRunnerDeps {
  jobId: string
  store: JobStore
  doc: JobDocHandles
  worker: WorkerCall
  /** The initiator may still edit the document (checked before every unit is applied). */
  canEdit: () => Promise<boolean>
  /** The error is a refusal by the AI budget (user key, free pool, workspace team). */
  isBudgetError: (e: unknown) => boolean
  publish: (progress: JobProgress) => void
  /** One usage record per worker call (logging). */
  onCallUsage?: (record: { ordinal: number, attempt: number, model: string, usage: WorkerCallUsage, latencyMs: number, costUsd: number | null }) => void
  /** Called with the cursor position the job is working at (awareness), or null when done. */
  onCursor?: (index: number | null) => void
  /** Worker calls per minute (default 40) and in flight at once (default 4). */
  requestsPerMinute?: number
  maxConcurrency?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Aborts every in-flight call (process shutdown). */
  signal?: AbortSignal
}
