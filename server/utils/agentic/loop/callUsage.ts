// Machine-readable usage record of one model call (one streamed turn).
//
// The loop logs one record per call as a structured `ai.call.usage` line
// and keeps them on the session telemetry, whose `ai-session-completed`
// event carries the totals. Plain data and pure functions only (no Nitro,
// no logger), so a delegated-job engine can reuse it and an eval harness
// can parse the log lines. Never put prompt or document text in here.

/** Log event name of a usage record; stable, eval harnesses match on it. */
export const CALL_USAGE_EVENT = 'ai.call.usage'

export interface CallUsageRecord {
  sessionId: string
  docId: string | null
  /** 1-based turn of the session; the closing turn has the next number. */
  turn: number
  /** `turn` for a work turn, `closing` for the wrap-up turn (`wrapUp.ts`). */
  phase: 'turn' | 'closing'
  /** Model / LiteLLM alias the request named. */
  requestedModel: string
  /** Model the provider reported in the response, when it named one. */
  providerModel: string | null
  promptTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  /** Request start to stream end (or failure). */
  latencyMs: number
  /** Request start to the first streamed chunk; null when none arrived. */
  firstTokenMs: number | null
  /** Provider finish reason (internal enum value); `error` when the stream failed. */
  finishReason: string | null
  /** This call re-requested a turn whose stream failed mid-way. */
  retry: boolean
}

export interface CallUsageInput {
  sessionId: string
  docId?: string | null
  turn: number
  phase?: 'turn' | 'closing'
  requestedModel: string
  providerModel?: string | null
  usage?: {
    promptTokenCount?: number
    cachedContentTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
  }
  startedAt: number
  firstChunkAt?: number | null
  endedAt: number
  finishReason?: string | null
  retry?: boolean
}

function count(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

export function buildCallUsageRecord(input: CallUsageInput): CallUsageRecord {
  const firstChunkAt = input.firstChunkAt ?? null
  return {
    sessionId: input.sessionId,
    docId: input.docId ?? null,
    turn: input.turn,
    phase: input.phase ?? 'turn',
    requestedModel: input.requestedModel,
    providerModel: input.providerModel ?? null,
    promptTokens: count(input.usage?.promptTokenCount),
    cachedTokens: count(input.usage?.cachedContentTokenCount),
    outputTokens: count(input.usage?.candidatesTokenCount),
    reasoningTokens: count(input.usage?.thoughtsTokenCount),
    latencyMs: Math.max(0, input.endedAt - input.startedAt),
    firstTokenMs: firstChunkAt === null ? null : Math.max(0, firstChunkAt - input.startedAt),
    finishReason: input.finishReason ?? null,
    retry: input.retry === true
  }
}

export interface CallUsageTotals {
  calls: number
  retries: number
  promptTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  latencyMs: number
}

export function sumCallUsage(records: readonly CallUsageRecord[]): CallUsageTotals {
  const totals: CallUsageTotals = { calls: 0, retries: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0 }
  for (const r of records) {
    totals.calls += 1
    if (r.retry) totals.retries += 1
    totals.promptTokens += r.promptTokens
    totals.cachedTokens += r.cachedTokens
    totals.outputTokens += r.outputTokens
    totals.reasoningTokens += r.reasoningTokens
    totals.latencyMs += r.latencyMs
  }
  return totals
}
