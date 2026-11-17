import { estimateTokens } from '../tools/sections/parse'
import type { WorkerPrice } from '../../litellm/workerPrices'
import type { JobMode } from './units'

// Cost and time estimate of a delegated job, computed server-side from the
// unit sizes so the planner cannot under-estimate (design: input =
// Σ (static prompt + job prompt + context + unit), output = Σ unit ×
// ratio(mode), plus 15 % for retries). Cache hits are ignored: the result
// is an upper bound. Pure (explicit imports only).

export interface EstimateInput {
  mode: JobMode
  /** Tokens of each unit. */
  unitTokens: readonly number[]
  /** Characters of the static system prompt and of the job part. */
  systemChars: number
  jobChars: number
  /** Read-only context per unit (before + after), tokens. Default 400. */
  contextTokensPerUnit?: number
  /** Price of the worker model; null = unknown (a user's own key, an operator endpoint). */
  price: WorkerPrice | null
  /** translate: source / target language codes, for the length ratio. */
  sourceLanguage?: string | null
  targetLanguage?: string | null
}

export interface JobEstimate {
  units: number
  inputTokens: number
  outputTokens: number
  /** USD on the platform budget; null when the price is unknown. */
  usd: number | null
  minutes: number
}

/** Worker calls per minute per job (leaves room in the key's 60 rpm for the editor). */
export const JOB_REQUESTS_PER_MINUTE = 40
/** Concurrent worker calls per job. */
export const JOB_MAX_CONCURRENCY = 4
/** Retries and review on top of the plain sum. */
const OVERHEAD = 1.15
/** Assumed worker output speed and fixed latency per call. */
const OUTPUT_TOKENS_PER_SECOND = 120
const CALL_LATENCY_SECONDS = 1.5

/** Expected output tokens of one unit. */
function expectedOutputTokens(mode: JobMode, unitTokens: number, sourceLanguage?: string | null, targetLanguage?: string | null): number {
  switch (mode) {
    case 'translate': {
      if (sourceLanguage === 'de' && targetLanguage === 'en') return Math.round(unitTokens * 0.85)
      if (sourceLanguage === 'en' && targetLanguage === 'de') return Math.round(unitTokens * 1.15)
      return unitTokens
    }
    case 'rewrite':
    case 'terminology':
      return unitTokens
    case 'summarise':
      return 150
    case 'comment':
      return 100
    case 'scan':
      return 400
  }
}

/** The worker's `max_tokens` for one unit: twice the expected output, at least 256. */
export function maxTokensFor(mode: JobMode, unitTokens: number, sourceLanguage?: string | null, targetLanguage?: string | null): number {
  return Math.max(256, 2 * expectedOutputTokens(mode, unitTokens, sourceLanguage, targetLanguage))
}

export function estimateJob(input: EstimateInput): JobEstimate {
  const fixedIn = estimateTokens(input.systemChars) + estimateTokens(input.jobChars) + (input.contextTokensPerUnit ?? 400)
  let inTokens = 0
  let outTokens = 0
  let seconds = 0
  for (const t of input.unitTokens) {
    const out = expectedOutputTokens(input.mode, t, input.sourceLanguage, input.targetLanguage)
    inTokens += fixedIn + t
    outTokens += out
    seconds += CALL_LATENCY_SECONDS + out / OUTPUT_TOKENS_PER_SECOND
  }
  const inputTokens = Math.round(inTokens * OVERHEAD)
  const outputTokens = Math.round(outTokens * OVERHEAD)
  const units = input.unitTokens.length
  const byRate = units / JOB_REQUESTS_PER_MINUTE
  const byLatency = seconds * OVERHEAD / JOB_MAX_CONCURRENCY / 60
  const usd = input.price ? inputTokens * input.price.input + outputTokens * input.price.output : null
  return {
    units,
    inputTokens,
    outputTokens,
    usd: usd === null ? null : Math.round(usd * 10_000) / 10_000,
    minutes: Math.max(0.1, Math.round(Math.max(byRate, byLatency) * 10) / 10)
  }
}

/** Confirmation thresholds: cost above $0.05, above 10 % of the remaining budget, or more than 30 units. */
const CONFIRM_MIN_USD = 0.05
const CONFIRM_BUDGET_SHARE = 0.1
const CONFIRM_MIN_UNITS = 30

/** Whether the user must confirm the job before it starts. `remainingBudgetUsd` null = unknown / not platform-billed. */
export function needsConfirmation(estimate: JobEstimate, remainingBudgetUsd: number | null): boolean {
  if (estimate.units > CONFIRM_MIN_UNITS) return true
  if (estimate.usd === null) return false
  if (estimate.usd > CONFIRM_MIN_USD) return true
  return remainingBudgetUsd !== null && estimate.usd > remainingBudgetUsd * CONFIRM_BUDGET_SHARE
}

/** Whether the estimate is more than the remaining platform budget. */
export function exceedsBudget(estimate: JobEstimate, remainingBudgetUsd: number | null): boolean {
  return estimate.usd !== null && remainingBudgetUsd !== null && estimate.usd > remainingBudgetUsd
}

/** Cost of one call from its usage (null when the price is unknown). */
export function callCostUsd(price: WorkerPrice | null, usage: { promptTokens: number, cachedTokens: number, outputTokens: number }): number | null {
  if (!price) return null
  const uncached = Math.max(0, usage.promptTokens - usage.cachedTokens)
  return uncached * price.input + usage.cachedTokens * price.cachedInput + usage.outputTokens * price.output
}
