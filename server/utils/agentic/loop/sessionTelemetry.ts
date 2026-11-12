import * as Sentry from '@sentry/nuxt'
import type { AiSession } from '../../ai/aiClient'
import { useLogger } from '../../platform/logger'

const loopLog = useLogger('ai-loop')

/**
 * Outcome categories surfaced to Sentry on session end. Indexed as a
 * tag (`outcome`) so dashboards can filter / count without parsing
 * extras.
 */
export type SessionOutcome
  = | 'success'
    | 'aborted'
    | 'error'
    | 'session-cap-exceeded'
    | 'budget-exhausted'
    | 'free-allowance-exhausted'
    | 'team-budget-exhausted'
    | 'member-limit-reached'
    | 'turn-limit'
    | 'stalled'

/**
 * Single-emit accumulator for the `ai-session-completed` Sentry event.
 * Every exit path (success / abort / error / cap) funnels through
 * `emit()` from the loop's finally block so dashboards can answer
 * "which sessions cost the most" without correlating LiteLLM spend
 * logs by hand.
 */
export class SessionTelemetry {
  readonly startedAt = Date.now()
  turnCount = 0
  totalInputTokens = 0
  totalOutputTokens = 0
  totalThinkingTokens = 0
  /** Prompt tokens served from the provider's prompt cache (billed at the cached rate). */
  totalCachedInputTokens = 0
  sawAnyUsageMetadata = false
  outcome: SessionOutcome = 'error'
  abortReason?: string
  errorMessage?: string
  /**
   * Per-tool ATTEMPT counts (records EVERY invocation, including
   * cap-rejected and errored ones). Distinct from SessionBudget's
   * tool-cap counter which only ticks on accepted slots.
   */
  readonly toolCallCounts = new Map<string, number>()

  noteUsage(usage: { promptTokenCount?: number, candidatesTokenCount?: number, thoughtsTokenCount?: number, cachedContentTokenCount?: number } | undefined): void {
    if (!usage) return
    if (usage.promptTokenCount === undefined && usage.candidatesTokenCount === undefined) return
    this.sawAnyUsageMetadata = true
    if (typeof usage.cachedContentTokenCount === 'number') this.totalCachedInputTokens += usage.cachedContentTokenCount
    if (typeof usage.promptTokenCount === 'number') this.totalInputTokens += usage.promptTokenCount
    if (typeof usage.candidatesTokenCount === 'number') this.totalOutputTokens += usage.candidatesTokenCount
    if (typeof usage.thoughtsTokenCount === 'number') this.totalThinkingTokens += usage.thoughtsTokenCount
  }

  noteToolAttempt(name: string): void {
    this.toolCallCounts.set(name, (this.toolCallCounts.get(name) ?? 0) + 1)
  }

  emit(args: {
    sessionId: string
    aiSession: AiSession
    plan: string
    attributedTo: string
    totalInteractions: number
  }): void {
    try {
      const toolCounts: Record<string, number> = {}
      for (const [k, v] of this.toolCallCounts) toolCounts[k] = v

      Sentry.captureMessage('ai-session-completed', {
        level: 'info',
        tags: {
          component: 'ai-session',
          event: 'completed',
          outcome: this.outcome,
          docId: args.aiSession.docId,
          // String for tag-search compatibility, Sentry's tag filter
          // works on string equality, not numeric comparison.
          initiatorUserId: String(args.aiSession.initiatorUserId)
        },
        extra: {
          sessionId: args.sessionId,
          turnCount: this.turnCount,
          totalInteractions: args.totalInteractions,
          // -1 sentinel when the SDK never surfaced usageMetadata,
          // preserves "no data" vs "actually 0" distinction.
          totalInputTokens: this.sawAnyUsageMetadata ? this.totalInputTokens : -1,
          totalOutputTokens: this.sawAnyUsageMetadata ? this.totalOutputTokens : -1,
          totalThinkingTokens: this.sawAnyUsageMetadata ? this.totalThinkingTokens : -1,
          totalCachedInputTokens: this.sawAnyUsageMetadata ? this.totalCachedInputTokens : -1,
          toolCallCounts: toolCounts,
          abortReason: this.abortReason,
          errorMessage: this.errorMessage,
          durationMs: Date.now() - this.startedAt,
          plan: args.plan,
          attributedTo: args.attributedTo
        }
      })
    } catch (e) {
      // Not the per-turn `log` helper (debug chatter): a telemetry failure
      // should stay visible at warn.
      loopLog.warn('telemetry capture failed', { err: e })
    }
  }
}
