import * as Y from 'yjs'
import { changedRuns, SuggestionLimitError, writeSuggestions, type SuggestSink } from '../tools/textWrite'
import { aiJobClientUserId } from '../../../../shared/contracts/jwt'
import { applyMinimalDiff } from '../tools/sections/ytextDiff'
import { parseSections } from '../tools/sections/parse'
import { leadingWhitespace, trailingWhitespace, unitContext, unitRev, type JobMode, type JobUnit } from './units'
import { maskText, unmaskText } from './mask'
import { buildWorkerPrompt, type WorkerJobSpec } from './workerPrompt'
import { fixWorkerDashes, parseCommentFindings, parseScanItems, retryFeedback, validateWorkerOutput, type CommentFinding, type ScanItem } from './validate'
import { addStableAnchors, documentHeadingSlugs } from './anchors'
import { checkGlossary } from './glossaryCheck'
import { JOB_MAX_CONCURRENCY, JOB_REQUESTS_PER_MINUTE, maxTokensFor } from './estimate'
import type { AiJobRow, AiJobStatus, AiJobUnitOutput, AiJobUnitRow, NewAiJobUnit } from '../../../repos/aiJobs'
import type { JobDocHandles, JobProgress, JobRunnerDeps, WorkerCallRequest, WorkerCallResult } from './jobTypes'

// One in-process worker per running job. Claims pending units (at most
// `maxConcurrency` in flight, `requestsPerMinute` call starts), and per
// unit: resolves its Y.js range, compares the text with the revision it
// had at job start, masks it, asks the worker, validates (retry with the
// problems, then once escalated, then skip), unmasks and applies the result
// as a minimal word diff in ONE transaction with origin `ai:job:<id>`.
// The job's status in the store is the control plane: a cancel (from any
// instance) is seen before the next claim and before every apply, and
// in-flight results are then discarded. No Nitro here: production wiring
// is `engine.ts`.

/** Transaction origin of a job's edits. */
export function jobOrigin(jobId: string): string {
  return `ai:job:${jobId}`
}

export function encodeRelativePosition(rel: Y.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(rel)).toString('base64')
}

export function decodeRelativePosition(encoded: string): Y.RelativePosition {
  return Y.decodeRelativePosition(new Uint8Array(Buffer.from(encoded, 'base64')))
}

/** Relative positions of [start, end): the start sticks to the first character, the end to the last, so text typed right outside stays outside. */
export function relativeRange(ytext: Y.Text, start: number, end: number): { startRel: string, endRel: string } {
  return {
    startRel: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, start, 0)),
    endRel: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, end, -1))
  }
}

/** The stored rows of freshly split units: Y.js positions, revision and before text. */
export function newUnitRows(ytext: Y.Text, units: readonly JobUnit[]): NewAiJobUnit[] {
  return units.map(u => ({
    ordinal: u.ordinal,
    headingPath: u.headingPath,
    ...relativeRange(ytext, u.start, u.end),
    revBefore: u.rev,
    unitTokens: u.tokens,
    beforeText: u.text
  }))
}

/** The unit's current range, or null when its text was deleted. */
export function resolveUnitRange(doc: JobDocHandles, startRel: string, endRel: string): { start: number, end: number } | null {
  const s = Y.createAbsolutePositionFromRelativePosition(decodeRelativePosition(startRel), doc.ydoc)
  const e = Y.createAbsolutePositionFromRelativePosition(decodeRelativePosition(endRel), doc.ydoc)
  if (!s || !e || s.type !== doc.ytext || e.type !== doc.ytext || e.index < s.index) return null
  return { start: s.index, end: e.index }
}

const TEMPERATURE: Record<JobMode, number> = {
  rewrite: 0.2,
  translate: 0.2,
  terminology: 0,
  summarise: 0.2,
  comment: 0,
  scan: 0
}

const ATTEMPTS = 3

export const REASON_CHANGED = 'Changed by someone else during the job; left as it was.'
const REASON_DELETED = 'Deleted during the job.'
const REASON_WORKER_FAILED = 'The AI model did not answer; the section was left as it was.'
export const REASON_ACCESS = 'The person who started the job can no longer edit this document.'
export const REASON_BUDGET = 'The AI budget is used up. Resume the job after a top-up or when the allowance renews.'
const REASON_SHUTDOWN = 'The server running the job stopped. Resume the job to continue.'

/** The note an applied unit keeps when the worker's em-dashes were replaced (`fixWorkerDashes`). */
function dashNote(fixed: number): string {
  return `Applied; ${fixed} em-dash${fixed === 1 ? '' : 'es'} the AI wrote ${fixed === 1 ? 'was' : 'were'} replaced automatically.`
}

type StopReason = 'cancelled' | 'stopped_access' | 'paused_budget' | 'aborted'

/** Specification the worker prompt is built from, read from the job row. */
export function jobSpecOf(job: Pick<AiJobRow, 'mode' | 'params'>): WorkerJobSpec {
  const p = job.params
  return {
    mode: job.mode,
    instruction: p.instruction,
    targetLanguage: p.targetLanguage ?? null,
    audience: p.audience ?? null,
    style: p.style ?? null,
    glossary: p.glossary ?? [],
    styleAnchors: p.styleAnchors ?? [],
    headingMap: p.headingMap ?? []
  }
}

/** Where the end of the unit's leading heading is (summary placement), or 0. */
function headingEnd(text: string): number {
  const lead = leadingWhitespace(text).length
  const first = parseSections(text).sections.find(s => s.level > 0)
  if (!first || first.startOffset !== lead) return 0
  return lineAfter(text, first.startOffset, first.headingLines)
}

function lineAfter(text: string, from: number, lines: number): number {
  let at = from
  for (let i = 0; i < lines; i++) {
    const nl = text.indexOf('\n', at)
    if (nl === -1) return text.length
    at = nl + 1
  }
  return at
}

/** The unit's new text from the worker's (unmasked) answer. */
export function composeUnitText(job: Pick<AiJobRow, 'mode' | 'params'>, original: string, answer: string): string {
  const body = answer.trim()
  if (job.mode !== 'summarise' || (job.params.placement ?? 'insert_at_start') === 'replace') {
    return leadingWhitespace(original) + body + trailingWhitespace(original)
  }
  if (job.params.placement === 'insert_at_end') {
    return `${original.trimEnd()}\n\n${body}${trailingWhitespace(original) || '\n'}`
  }
  const cut = headingEnd(original)
  if (cut === 0) return `${leadingWhitespace(original)}${body}\n\n${original.trimStart()}`
  const head = original.slice(0, cut).trimEnd()
  const rest = original.slice(cut).replace(/^\s*\n/, '')
  return rest.trim() === '' ? `${head}\n\n${body}${trailingWhitespace(original) || '\n'}` : `${head}\n\n${body}\n\n${rest}`
}

class RateGate {
  private next = 0
  constructor(private readonly intervalMs: number, private readonly now: () => number, private readonly sleep: (ms: number) => Promise<void>) {}

  async wait(): Promise<void> {
    const now = this.now()
    const at = Math.max(now, this.next)
    this.next = at + this.intervalMs
    if (at > now) await this.sleep(at - now)
  }
}

interface UnitOutcome {
  status: 'applied' | 'skipped' | 'failed' | 'requeued'
}

interface LadderUsage { costUsd: number, tokensIn: number, tokensOut: number }

type LadderResult
  = | { kind: 'accepted', answer: string, placeholders: string[], attempts: number, usage: LadderUsage, note: string | null }
    | { kind: 'rejected', problems: string[], attempts: number, usage: LadderUsage }
    | { kind: 'failed', attempts: number, usage: LadderUsage }
    | { kind: 'requeue' }

/** One preview unit: the original and what the job would write (nothing is applied). */
export interface PreviewSample {
  ordinal: number
  headingPath: string
  before: string
  after: string
  ok: boolean
  problems: string[]
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Map of the outcome of the run. */
export interface JobRunResult {
  status: AiJobStatus
  done: number
  skipped: number
  flagged: number
}

export class JobRunner {
  private stop: StopReason | null = null
  private readonly gate: RateGate
  private readonly abort = new AbortController()
  private job!: AiJobRow
  private costUnknown = false

  constructor(private readonly deps: JobRunnerDeps) {
    const rpm = deps.requestsPerMinute ?? JOB_REQUESTS_PER_MINUTE
    this.gate = new RateGate(60_000 / rpm, deps.now ?? Date.now, deps.sleep ?? defaultSleep)
    deps.signal?.addEventListener('abort', () => this.halt('aborted'), { once: true })
  }

  /** Stop dispatching and discard what is in flight (the store status says why). */
  halt(reason: StopReason): void {
    this.stop ??= reason
    this.abort.abort()
  }

  async run(): Promise<JobRunResult> {
    const job = await this.deps.store.getJob()
    if (!job || job.status !== 'running') {
      return { status: job?.status ?? 'failed', done: job?.unitsDone ?? 0, skipped: job?.unitsSkipped ?? 0, flagged: job?.unitsFlagged ?? 0 }
    }
    this.job = job
    this.costUnknown = !job.costKnown
    const max = Math.max(1, this.deps.maxConcurrency ?? JOB_MAX_CONCURRENCY)
    const inflight = new Set<Promise<UnitOutcome>>()
    for (;;) {
      if (this.stop) break
      const live = await this.deps.store.getJob()
      if (!live || live.status !== 'running') {
        this.halt('cancelled')
        break
      }
      if (inflight.size >= max) {
        await Promise.race(inflight)
        continue
      }
      const claimed = await this.deps.store.claimUnits(max - inflight.size)
      for (const unit of claimed) {
        const p: Promise<UnitOutcome> = this.processUnit(unit).finally(() => inflight.delete(p))
        inflight.add(p)
      }
      if (claimed.length === 0) {
        if (inflight.size === 0) break
        await Promise.race(inflight)
      }
    }
    await Promise.allSettled([...inflight])
    return this.finish()
  }

  private async processUnit(unit: AiJobUnitRow): Promise<UnitOutcome> {
    try {
      return await this.processUnitInner(unit)
    } catch (e) {
      // A store error: leave the unit for a resume rather than lose it.
      await this.deps.store.updateUnit(unit.ordinal, { status: 'pending' }).catch(() => undefined)
      this.halt('aborted')
      throw e
    }
  }

  private async requeue(unit: AiJobUnitRow): Promise<UnitOutcome> {
    await this.deps.store.updateUnit(unit.ordinal, { status: 'pending' })
    return { status: 'requeued' }
  }

  private currentUnitText(unit: AiJobUnitRow): { start: number, end: number, text: string } | null {
    const range = resolveUnitRange(this.deps.doc, unit.startRel, unit.endRel)
    if (!range) return null
    return { ...range, text: this.deps.doc.ytext.toString().slice(range.start, range.end) }
  }

  private async skip(unit: AiJobUnitRow, status: 'skipped' | 'failed', reason: string, extra: { attempts?: number, costUsd?: number, tokensIn?: number, tokensOut?: number, retried?: number } = {}): Promise<UnitOutcome> {
    await this.deps.store.updateUnit(unit.ordinal, { status, reason, attempts: extra.attempts ?? unit.attempts, costUsd: extra.costUsd ?? 0, tokensIn: extra.tokensIn ?? 0, tokensOut: extra.tokensOut ?? 0 })
    await this.progress({ skipped: 1, retried: extra.retried ?? 0, costUsd: extra.costUsd ?? 0, tokensIn: extra.tokensIn ?? 0, tokensOut: extra.tokensOut ?? 0 }, unit.headingPath)
    return { status }
  }

  private async processUnitInner(unit: AiJobUnitRow): Promise<UnitOutcome> {
    if (this.stop) return this.requeue(unit)
    const at = this.currentUnitText(unit)
    if (!at) return this.skip(unit, 'skipped', REASON_DELETED)
    if (unitRev(at.text) !== unit.revBefore) return this.skip(unit, 'skipped', REASON_CHANGED)
    this.deps.onCursor?.(at.start)
    const r = await this.ladder(unit, at)
    if (r.kind === 'requeue') return this.requeue(unit)
    const stats = { attempts: r.attempts, retried: Math.max(0, r.attempts - 1), ...r.usage }
    if (r.kind === 'failed') return this.skip(unit, 'failed', REASON_WORKER_FAILED, stats)
    if (r.kind === 'rejected') {
      const why = r.problems.slice(0, 3).join(' ')
      return this.skip(unit, 'skipped', `The AI's answer failed the checks ${r.attempts} times: ${why}`.slice(0, 1000), stats)
    }
    return this.apply(unit, r.answer, r.placeholders, { ...stats, note: r.note })
  }

  /** One worker call: its result, `requeue` (budget refusal or stop) or `failed` (any other error). */
  private async callWorker(unit: AiJobUnitRow, messages: WorkerCallRequest['messages'], attempt: number): Promise<WorkerCallResult | 'requeue' | 'failed'> {
    try {
      return await this.deps.worker({
        messages,
        temperature: TEMPERATURE[this.job.mode],
        maxTokens: maxTokensFor(this.job.mode, unit.unitTokens, this.job.params.sourceLanguage, this.job.params.targetLanguage),
        escalated: attempt === ATTEMPTS,
        cacheKey: `job:${this.job.id}`,
        signal: this.abort.signal
      })
    } catch (e) {
      if (this.deps.isBudgetError(e)) {
        this.halt('paused_budget')
        return 'requeue'
      }
      return this.stop ? 'requeue' : 'failed'
    }
  }

  private addUsage(usage: LadderUsage, unit: AiJobUnitRow, attempt: number, result: WorkerCallResult): void {
    usage.tokensIn += result.usage.promptTokens
    usage.tokensOut += result.usage.outputTokens
    if (result.costUsd === null) this.costUnknown = true
    else usage.costUsd += result.costUsd
    this.deps.onCallUsage?.({ ordinal: unit.ordinal, attempt, model: result.model, usage: result.usage, latencyMs: result.latencyMs, costUsd: result.costUsd })
  }

  /**
   * The worker call with the retry ladder: the plain call, the same worker
   * with the validator's problems appended, then once escalated. A budget
   * refusal halts the job (`paused_budget`).
   */
  private async ladder(unit: AiJobUnitRow, at: { start: number, end: number, text: string }): Promise<LadderResult> {
    const masked = maskText(at.text)
    const context = unitContext(this.deps.doc.ytext.toString(), at.start, at.end)
    const spec = jobSpecOf(this.job)
    const usage = { costUsd: 0, tokensIn: 0, tokensOut: 0 }
    let problems: string[] = []
    let attempts = 0
    let workerFailed = false
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (this.stop) return { kind: 'requeue' }
      await this.gate.wait()
      if (this.stop) return { kind: 'requeue' }
      attempts = attempt
      const prompt = buildWorkerPrompt(spec, { headingPath: unit.headingPath, before: context.before, after: context.after, unit: masked.masked, retryProblems: problems })
      const result = await this.callWorker(unit, prompt.messages, attempt)
      if (result === 'requeue') return { kind: 'requeue' }
      workerFailed = result === 'failed'
      if (result === 'failed') continue
      this.addUsage(usage, unit, attempt, result)
      // Em-dashes are fixed here instead of failing the unit (a retry would cost a call).
      const dashes = fixWorkerDashes(this.job.mode, masked.masked, result.text)
      const check = validateWorkerOutput({
        mode: this.job.mode,
        source: masked.masked,
        output: dashes.output,
        placeholderCount: masked.placeholders.length,
        glossary: this.job.params.glossary,
        targetLanguage: this.job.params.targetLanguage,
        lengthBand: this.job.params.lengthBand ?? null
      })
      if (check.ok) return { kind: 'accepted', answer: dashes.output, placeholders: masked.placeholders, attempts, usage, note: dashes.fixed > 0 ? dashNote(dashes.fixed) : null }
      problems = retryFeedback(check)
    }
    return workerFailed ? { kind: 'failed', attempts, usage } : { kind: 'rejected', problems, attempts, usage }
  }

  /**
   * Run the worker on the listed units WITHOUT applying anything: the
   * preview the planner checks before it starts the job. Each sample is
   * also stored on its unit (`output.kind = 'preview'`); the units stay
   * pending. Works in any status but `running`.
   */
  async preview(ordinals: readonly number[]): Promise<PreviewSample[]> {
    const job = await this.deps.store.getJob()
    if (!job || job.status === 'running') return []
    this.job = job
    const units = (await this.deps.store.listUnits()).filter(u => ordinals.includes(u.ordinal))
    const samples: PreviewSample[] = []
    for (const unit of units) {
      const sample = await this.previewOne(unit)
      if (sample === 'stop') break
      if (sample) samples.push(sample)
    }
    if (this.costUnknown && job.costKnown) await this.deps.store.update({ costKnown: false })
    return samples
  }

  private async previewOne(unit: AiJobUnitRow): Promise<PreviewSample | null | 'stop'> {
    const at = this.currentUnitText(unit)
    if (!at) return null
    const r = await this.ladder(unit, at)
    if (r.kind === 'requeue') return 'stop'
    const after = r.kind === 'accepted' ? this.previewText(unit, at.text, r.answer, r.placeholders) : ''
    const problems = r.kind === 'rejected' ? r.problems : r.kind === 'failed' ? [REASON_WORKER_FAILED] : []
    await this.deps.store.updateUnit(unit.ordinal, { output: { kind: 'preview', after, problems } })
    if (r.usage.costUsd > 0 || r.usage.tokensIn > 0) await this.deps.store.addProgress({ costUsd: r.usage.costUsd, tokensIn: r.usage.tokensIn, tokensOut: r.usage.tokensOut })
    return { ordinal: unit.ordinal, headingPath: unit.headingPath, before: at.text, after, ok: r.kind === 'accepted', problems }
  }

  private previewText(unit: AiJobUnitRow, original: string, answer: string, placeholders: string[]): string {
    // Findings and scan items: parsed first, then unmasked per field, so a
    // placeholder's content (code with quotes, newlines) cannot break the JSON.
    if (this.job.mode === 'comment' || this.job.mode === 'scan') return JSON.stringify(structuredOutput(this.job.mode, answer, placeholders))
    return composeUnitText(this.job, original, unmaskText(answer, placeholders))
  }

  private async apply(unit: AiJobUnitRow, answer: string, placeholders: string[], stats: { attempts: number, retried: number, costUsd: number, tokensIn: number, tokensOut: number, note: string | null }): Promise<UnitOutcome> {
    if (this.stop) return this.requeue(unit)
    const live = await this.deps.store.getJob()
    if (!live || live.status !== 'running') {
      this.halt('cancelled')
      return this.requeue(unit)
    }
    if (!(await this.deps.canEdit())) {
      this.halt('stopped_access')
      return this.requeue(unit)
    }
    const at = this.currentUnitText(unit)
    if (!at) return this.skip(unit, 'skipped', REASON_DELETED, stats)
    if (unitRev(at.text) !== unit.revBefore) return this.skip(unit, 'skipped', REASON_CHANGED, stats)

    const base = { attempts: stats.attempts, costUsd: stats.costUsd, tokensIn: stats.tokensIn, tokensOut: stats.tokensOut }
    const delta = { done: 1, retried: stats.retried, costUsd: stats.costUsd, tokensIn: stats.tokensIn, tokensOut: stats.tokensOut }
    if (this.job.mode === 'comment' || this.job.mode === 'scan') {
      const output: AiJobUnitOutput = this.job.mode === 'comment'
        ? { kind: 'comments', findings: structuredOutput('comment', answer, placeholders) as CommentFinding[] }
        : { kind: 'scan', items: structuredOutput('scan', answer, placeholders) as ScanItem[] }
      await this.deps.store.updateUnit(unit.ordinal, { ...base, status: 'applied', output, reason: stats.note })
      await this.progress(delta, unit.headingPath)
      return { status: 'applied' }
    }

    let next = composeUnitText(this.job, at.text, unmaskText(answer, placeholders))
    if (this.job.mode === 'translate' && this.job.params.anchors !== false) {
      const slugs = documentHeadingSlugs(this.deps.doc.ytext.toString())
        .filter(h => h.startOffset >= at.start && h.startOffset < at.end)
        .map(h => h.slug)
      next = addStableAnchors(at.text, next, slugs).text
    }
    const { ydoc, ytext } = this.deps.doc
    if (this.job.params.suggest) {
      const refused = this.suggestUnit(unit, at, next)
      if (refused) return this.skip(unit, 'skipped', refused, stats)
    } else {
      ydoc.transact(() => {
        applyMinimalDiff(ytext, at.start, at.end, next)
      }, jobOrigin(this.job.id))
    }
    const rels = relativeRange(ytext, at.start, at.start + (this.job.params.suggest ? at.text.length : next.length))
    await this.deps.store.updateUnit(unit.ordinal, { ...base, ...rels, status: 'applied', afterHash: unitRev(next), sessionAfterHash: null, reason: stats.note })
    await this.progress(delta, unit.headingPath)
    return { status: 'applied' }
  }

  /**
   * Suggestion mode: the unit's change becomes suggestions (one per changed
   * run of words) and the text stays as it is. `afterHash` still names the
   * job's text, so undo finds a unit a person accepted. Returns why the
   * unit could not be suggested, or null.
   */
  private suggestUnit(unit: AiJobUnitRow, at: { start: number, text: string }, next: string): string | null {
    const { ydoc, ytext } = this.deps.doc
    const sink: SuggestSink = { principal: aiJobClientUserId(this.job.id), name: 'markoto', jobId: this.job.id, forced: false, written: 0 }
    const hunks = changedRuns(at.text, next).map(h => ({ from: at.start + h.from, to: at.start + h.to, text: h.text }))
    try {
      ydoc.transact(() => {
        writeSuggestions(ydoc, ytext, hunks, sink, `job:${this.job.id}:${unit.ordinal}`)
      }, jobOrigin(this.job.id))
      return null
    } catch (e) {
      if (e instanceof SuggestionLimitError) return e.message
      throw e
    }
  }

  private async progress(delta: Parameters<JobRunnerDeps['store']['addProgress']>[0], heading: string | null): Promise<void> {
    const row = await this.deps.store.addProgress(delta)
    if (heading !== null) await this.deps.store.update({ currentHeading: heading })
    if (row) this.deps.publish(progressOf({ ...row, currentHeading: heading, costKnown: row.costKnown && !this.costUnknown }))
  }

  private async finish(): Promise<JobRunResult> {
    const { store } = this.deps
    this.deps.onCursor?.(null)
    if (this.costUnknown && this.job.costKnown) await store.update({ costKnown: false })
    const status = this.stop ? await this.finishStopped(this.stop) : await this.finishComplete()
    const row = await store.getJob()
    if (row) this.deps.publish(progressOf({ ...row, costKnown: row.costKnown && !this.costUnknown }))
    return { status, done: row?.unitsDone ?? 0, skipped: row?.unitsSkipped ?? 0, flagged: row?.unitsFlagged ?? 0 }
  }

  private async finishStopped(stop: StopReason): Promise<AiJobStatus> {
    const { store } = this.deps
    await store.requeueRunning()
    const target: Record<StopReason, { status: AiJobStatus, reason: string | null }> = {
      cancelled: { status: 'cancelled', reason: null },
      stopped_access: { status: 'stopped_access', reason: REASON_ACCESS },
      paused_budget: { status: 'paused_budget', reason: REASON_BUDGET },
      aborted: { status: 'interrupted', reason: REASON_SHUTDOWN }
    }
    const t = target[stop]
    // A cancel was written by whoever cancelled; the store already says so.
    if (stop !== 'cancelled') {
      await store.transition(['running'], t.status, { reason: t.reason, currentHeading: null, ...(t.status === 'stopped_access' ? { finishedAt: new Date() } : {}) })
    }
    return (await store.getJob())?.status ?? t.status
  }

  private async finishComplete(): Promise<AiJobStatus> {
    const { store } = this.deps
    await this.flagGlossary()
    const units = await store.listUnits()
    const applied = units.filter(u => u.status === 'applied' || u.status === 'flagged').length
    const failed = units.filter(u => u.status === 'failed').length
    const status: AiJobStatus = applied === 0 && failed > 0 ? 'failed' : 'done'
    await store.transition(['running'], status, { finishedAt: new Date(), currentHeading: null, reason: status === 'failed' ? REASON_WORKER_FAILED : null })
    return (await store.getJob())?.status ?? status
  }

  /** Post-job glossary check (translate / terminology): flag the units that break it. */
  private async flagGlossary(): Promise<void> {
    const glossary = this.job.params.glossary ?? []
    if (glossary.length === 0 || (this.job.mode !== 'translate' && this.job.mode !== 'terminology')) return
    const applied = await this.deps.store.listUnits(['applied'])
    const checks = applied.flatMap((u) => {
      const at = u.beforeText === null ? null : this.currentUnitText(u)
      return at && u.beforeText !== null ? [{ ordinal: u.ordinal, source: u.beforeText, output: at.text }] : []
    })
    const flagged = checkGlossary(checks, glossary, this.job.mode)
    for (const f of flagged) {
      const terms = f.violations.map(v => `${v.source} -> ${v.target} (${v.kind.replace(/_/g, ' ')})`).join('; ')
      await this.deps.store.updateUnit(f.ordinal, { status: 'flagged', reason: `Glossary not followed: ${terms}`.slice(0, 1000) })
    }
    if (flagged.length > 0) await this.deps.store.addProgress({ flagged: flagged.length })
  }
}

/** Comment findings or scan items of a worker answer, with placeholders restored in every text field. */
function structuredOutput(mode: 'comment' | 'scan', answer: string, placeholders: readonly string[]): CommentFinding[] | ScanItem[] {
  if (mode === 'comment') return parseCommentFindings(answer).map(f => ({ ...f, quote: unmaskText(f.quote, placeholders) }))
  return parseScanItems(answer).map(i => ({ ...i, text: unmaskText(i.text, placeholders), ...(i.example ? { example: unmaskText(i.example, placeholders) } : {}) }))
}

export function progressOf(row: Pick<AiJobRow, 'id' | 'status' | 'unitsDone' | 'unitsSkipped' | 'unitsFlagged' | 'unitsTotal' | 'currentHeading' | 'costUsd' | 'costKnown'>): JobProgress {
  return {
    jobId: row.id,
    status: row.status,
    done: row.unitsDone,
    skipped: row.unitsSkipped,
    flagged: row.unitsFlagged,
    total: row.unitsTotal,
    currentHeading: row.currentHeading,
    costUsd: Math.round(row.costUsd * 10_000) / 10_000,
    costKnown: row.costKnown
  }
}

/** Run a job to its end (or stop) with the given seams. */
export async function runJob(deps: JobRunnerDeps): Promise<JobRunResult> {
  return new JobRunner(deps).run()
}
