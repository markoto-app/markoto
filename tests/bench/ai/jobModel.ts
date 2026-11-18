import type * as Y from 'yjs'
import { buildJobUnits, unitContext, type JobUnit } from '../../../server/utils/ai/jobs/units'
import { maskText } from '../../../server/utils/ai/jobs/mask'
import { buildJobPart, buildWorkerPrompt, WORKER_SYSTEM_PROMPT } from '../../../server/utils/ai/jobs/workerPrompt'
import { estimateJob, maxTokensFor, type JobEstimate } from '../../../server/utils/ai/jobs/estimate'
import { jobSpecOf } from '../../../server/utils/ai/jobs/runner'
import { WORKER_PRICES } from '../../../server/utils/litellm/workerPrices'
import type { AiJobRow } from '../../../server/repos/aiJobs'
import type { CreateJobInput } from '../../../server/utils/ai/jobs/engine'
/** Same token estimate as the harness (`harness.ts`, CHARS_PER_TOKEN). */
const CHARS_PER_TOKEN = 3.6

// The job engine as the benchmark models it. The harness has no database,
// sync server or worker model, so this stands in for
// `server/utils/ai/jobs/engine.ts`: jobs live in memory, previews return a
// same-length stand-in, and starting a job models every worker call the
// real runner would make with the pure modules (unit splitter, masking,
// worker prompt, estimate): input = the exact worker prompt per unit,
// output = the unit's masked text (rewrite / translate keep the length).
// Worker cost uses the `markoto-worker` alias price (GLM-5.3 Flash) with
// the system prompt and job part cached after the first call.

const PRICE = WORKER_PRICES['markoto-worker']

export interface WorkerUsage {
  calls: number
  inputTokens: number
  /** Input tokens of the static system prompt + job part (cacheable within a job). */
  cachedPrefixTokens: number
  outputTokens: number
  costUncachedUsd: number
  costCachedUsd: number
  estimate: JobEstimate | null
}

const empty = (): WorkerUsage => ({ calls: 0, inputTokens: 0, cachedPrefixTokens: 0, outputTokens: 0, costUncachedUsd: 0, costCachedUsd: 0, estimate: null })
let usage: WorkerUsage = empty()
const jobs = new Map<string, { row: AiJobRow, units: JobUnit[], text: string }>()
let seq = 0

/** The worker usage since the last reset (one benchmark task). */
export function takeWorkerUsage(): WorkerUsage {
  const out = usage
  usage = empty()
  return out
}

const tokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN)

function modelCalls(row: AiJobRow, units: readonly JobUnit[], text: string): void {
  const spec = jobSpecOf(row)
  const prefixTokens = tokens(WORKER_SYSTEM_PROMPT.length + buildJobPart(spec).length)
  for (const unit of units) {
    const masked = maskText(unit.text)
    const ctx = unitContext(text, unit.start, unit.end)
    const prompt = buildWorkerPrompt(spec, { headingPath: unit.headingPath, before: ctx.before, after: ctx.after, unit: masked.masked })
    const inTok = tokens(prompt.messages.reduce((s, m) => s + m.content.length, 0))
    const outTok = Math.min(tokens(masked.masked.length), maxTokensFor(row.mode, unit.tokens))
    usage.calls += 1
    usage.inputTokens += inTok
    usage.outputTokens += outTok
    // The first call of a job writes the cache; later calls read the prefix.
    const cached = usage.calls > 1 ? prefixTokens : 0
    usage.cachedPrefixTokens += cached
    usage.costUncachedUsd += inTok * PRICE.input + outTok * PRICE.output
    usage.costCachedUsd += (inTok - cached) * PRICE.input + cached * PRICE.cachedInput + outTok * PRICE.output
  }
}

function rowOf(input: CreateJobInput, units: JobUnit[], estimate: JobEstimate): AiJobRow {
  const now = new Date()
  return {
    id: `j-bench${String(++seq).padStart(6, '0')}`,
    docId: input.doc.docId,
    initiatorUserId: 1,
    workspaceId: null,
    sessionId: input.sessionId,
    mode: input.mode,
    status: 'preview',
    params: input.params,
    estimate,
    costUsd: 0,
    costKnown: true,
    tokensIn: 0,
    tokensOut: 0,
    unitsTotal: units.length,
    unitsDone: 0,
    unitsSkipped: 0,
    unitsFlagged: 0,
    unitsRetried: 0,
    workerModel: 'markoto-worker',
    reason: null,
    currentHeading: null,
    heartbeatAt: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null
  }
}

/** Same-length stand-in for a worker's rewrite (vowels shifted on prose lines). */
function standIn(text: string): string {
  const shift: Record<string, string> = { a: 'e', e: 'i', i: 'o', o: 'u', u: 'a' }
  return text.split('\n').map(l => (l.startsWith('#') || l.startsWith('```') || l.includes('](') ? l : l.replace(/[aeiou]/g, c => shift[c] ?? c))).join('\n')
}

function job(id: string) {
  const j = jobs.get(id)
  if (!j) throw new Error(`no bench job ${id}`)
  return j
}

/** The engine functions `delegateTools.ts` imports (vi.mock target). */
export const benchEngine = {
  async createJob(input: CreateJobInput) {
    const text = (input.ytext as Y.Text).toString()
    const units = buildJobUnits(text, input.targets, { mode: input.mode, granularity: input.params.granularity ?? 'auto' })
    const estimate = estimateJob({
      mode: input.mode,
      unitTokens: units.map(u => u.tokens),
      systemChars: WORKER_SYSTEM_PROMPT.length,
      jobChars: buildJobPart(jobSpecOf({ mode: input.mode, params: input.params })).length,
      price: PRICE,
      sourceLanguage: input.params.sourceLanguage ?? null,
      targetLanguage: null
    })
    const row = rowOf(input, units, estimate)
    jobs.set(row.id, { row, units, text })
    usage.estimate = estimate
    return { job: row, units, estimate }
  },
  async previewJob(_doc: unknown, jobId: string, ordinals: readonly number[]) {
    const j = job(jobId)
    const picked = j.units.filter(u => ordinals.includes(u.ordinal))
    modelCalls(j.row, picked, j.text)
    return picked.map(u => ({ ordinal: u.ordinal, headingPath: u.headingPath, before: u.text, after: standIn(u.text), ok: true, problems: [] }))
  },
  async awaitConfirmation(_doc: unknown, jobId: string) {
    job(jobId).row.status = 'awaiting_confirmation'
  },
  async startJob(_doc: unknown, jobId: string) {
    const j = job(jobId)
    modelCalls(j.row, j.units, j.text)
    j.row.status = 'running'
    return { ...j.row }
  },
  async cancelJob(_doc: unknown, jobId: string) {
    const j = job(jobId)
    j.row.status = 'cancelled'
    return { ...j.row }
  },
  async rerunJobUnits(_doc: unknown, jobId: string) {
    return { ...job(jobId).row }
  },
  async getJobProgress() {
    return null
  },
  async getJobReport(_doc: unknown, jobId: string) {
    return { job: { ...job(jobId).row }, notes: [] }
  },
  async listJobFindings() {
    return []
  },
  async scanDocument() {
    throw new Error('not modelled')
  }
}
