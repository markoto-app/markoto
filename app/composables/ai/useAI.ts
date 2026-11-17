import type { Awareness } from 'y-protocols/awareness'
import type { EditorSelectionSnapshot } from '~~/shared/types/editorSelection'
import { useAwarenessAiSessions } from './aiAwarenessSessions'
import { aiErrorStatus, useAiSessionTracking } from './aiSessionTracking'
import type { AiConfirmationRequest, AiEventSource, MyAiSessionInfo } from '~/types/ai/session'
import { aiStepText } from '~/utils/ai/statusText'
import { analyticsClient } from '~/utils/analytics/analyticsClient'
import { ANALYTICS_EVENTS } from '~~/shared/analytics/events'
import { APP_PATH } from '~~/shared/analytics/pages'

// `ai_first_use` goes out once per tab (no content, no document id).
let aiUseTracked = false

export type { AiConfirmationRequest, AiEventSource, AiResponseEntry, AiSessionInfo, AiSessionOutcome, MyAiSessionInfo } from '~/types/ai/session'

export interface UseAIOptions {
  /**
   * Optional callback invoked at prompt-submit time to snapshot the
   * user's current caret or selection. The result is shipped alongside
   * the prompt so the server can wrap it with `<editor_state>` context
   * for the model. Called lazily (only when a prompt is actually sent),
   * so a costly read is fine.
   */
  getEditorSelection?: () => EditorSelectionSnapshot
  /** Poll cadence for the fallback polling of the private session status (ms). */
  pollIntervalMs?: number
  /**
   * Opens the push stream (`GET /api/ai/sessions/:id/stream`). Defaults
   * to the browser's `EventSource`; `null` = no streaming, poll only
   * (also what happens where `EventSource` doesn't exist).
   */
  createEventSource?: ((url: string) => AiEventSource) | null
}

function defaultEventSourceFactory(): ((url: string) => AiEventSource) | null {
  if (typeof EventSource === 'undefined') return null
  return url => new EventSource(url)
}

const DEFAULT_POLL_MS = 600

/**
 * Exposes AI prompt / abort / confirm actions and reactive session state.
 *
 * Two sources:
 *   - Y.js awareness: the AI joins the document as its own client, so
 *     every tab sees the AI appear, change phase and leave. Only
 *     public fields ride there.
 *   - The initiator's private channel, while I have a session, the
 *     composable follows the push stream `GET /api/ai/sessions/:id/stream`
 *     (Server-Sent Events) for the prompt, the live status text,
 *     `message_to_user` answers and confirmation requests ("markoto
 *     wants to read 'Q3 plan'"), and answers those through
 *     `POST …/confirm`. If the stream can't be opened or keeps failing
 *     it falls back to polling `GET /api/ai/sessions/:id`.
 *
 * The `editorSelection` override is consumed by the bottom prompt bar so
 * cursor / selection state flows through to the server's `<editor_state>`
 * wrapper, letting the agentic loop pick the right edit tool.
 */
export function useAI(docId: Ref<string>, awareness: Awareness, options: UseAIOptions = {}) {
  const { refresh: refreshAiAvailability } = useAiAvailability()
  const { extractError } = useErrorHandler()
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const createEventSource = options.createEventSource === undefined
    ? defaultEventSourceFactory()
    : options.createEventSource

  const { activeSessions, mySessionId, otherSessions } = useAwarenessAiSessions(awareness)

  const submitting = ref(false)
  const lastError = ref<string | null>(null)
  // Set on a 402 from `/api/ai/prompt` so the UI shows the upgrade CTA instead
  // of the generic failure toast. Cleared on the next prompt or `clearLastError()`.
  const budgetExhausted = ref(false)
  // The shared monthly free-tier pool is used up (402
  // `ai/free-allowance-exhausted`): distinct from the user's own points.
  const freeAllowanceExhausted = ref(false)

  const { t } = useI18n()
  const { privateStatus, startedSessionId, lastResponse, lastOutcome } = useAiSessionTracking({
    mySessionId, lastError, pollMs, createEventSource, stepText: step => aiStepText(step, t)
  })

  const mySession = computed<MyAiSessionInfo | null>(() => {
    const sid = mySessionId.value
    if (!sid) return null
    const pub = activeSessions.value.find(s => s.sessionId === sid)
    if (!pub) return null
    const priv = privateStatus.value?.sessionId === sid ? privateStatus.value : null
    return {
      ...pub,
      phase: priv?.phase ?? pub.phase,
      prompt: priv?.prompt ?? '',
      message: priv?.message ?? null,
      step: priv?.step ?? null,
      confirmation: priv?.confirmation ?? null
    }
  })

  /** The confirmation the AI is waiting for, if any. */
  const pendingConfirmation = computed<AiConfirmationRequest | null>(() => mySession.value?.confirmation ?? null)
  const answeringConfirmation = ref(false)

  async function answerConfirmation(allow: boolean): Promise<void> {
    const sid = mySessionId.value
    const c = pendingConfirmation.value
    if (!sid || !c || answeringConfirmation.value) return
    answeringConfirmation.value = true
    try {
      await apiFetch('/api/ai/sessions/:sessionId/confirm', {
        method: 'post',
        path: { sessionId: sid },
        body: { confirmationId: c.id, allow }
      })
    } catch (e) {
      // 409 = already answered / timed out, the next update shows the
      // current state; anything else is worth a toast.
      if (aiErrorStatus(e) !== 409) {
        lastError.value = extractError(e).message
      }
    } finally {
      answeringConfirmation.value = false
      // Hide the answered request right away; the next update confirms.
      const cur = privateStatus.value
      if (cur?.confirmation?.id === c.id) privateStatus.value = { ...cur, confirmation: null }
    }
  }

  async function prompt(
    text: string,
    overrides?: { editorSelection?: EditorSelectionSnapshot }
  ): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed || submitting.value || mySessionId.value) return false
    submitting.value = true
    lastError.value = null
    lastOutcome.value = null
    budgetExhausted.value = false
    freeAllowanceExhausted.value = false
    // The call-site override (selection popup passes a pre-captured range) wins
    // over `options.getEditorSelection`. Absent = server treats it as `kind: 'none'`.
    const editorSelection = overrides?.editorSelection ?? options.getEditorSelection?.()
    try {
      const res = await apiFetch('/api/ai/prompt', {
        method: 'post',
        body: { docId: docId.value, prompt: trimmed, editorSelection }
      })
      if (typeof res?.sessionId === 'string') startedSessionId.value = res.sessionId
      if (!aiUseTracked) {
        aiUseTracked = true
        analyticsClient().track(ANALYTICS_EVENTS.aiFirstUse, {}, APP_PATH)
      }
      return true
    } catch (e) {
      const { statusCode, code, message } = extractError(e)
      if (code === 'ai/provider-missing') {
        // Availability snapshot was stale (provider removed in another
        // tab, instance default dropped), refresh so the prompt bar
        // swaps to the "Add your API key" call-to-action.
        void refreshAiAvailability()
      }
      if (code === 'ai/free-allowance-exhausted') {
        // Shared free pool used up: the prompt bar shows the
        // "add your own key" toast, not the per-user points one.
        freeAllowanceExhausted.value = true
      } else if (statusCode === 402) {
        budgetExhausted.value = true
      }
      lastError.value = message
      return false
    } finally {
      submitting.value = false
    }
  }

  async function abort(): Promise<void> {
    const id = mySessionId.value
    if (!id) return
    try {
      await apiFetch('/api/ai/abort', {
        method: 'post',
        body: { sessionId: id }
      })
    } catch (e) {
      const { statusCode, message } = extractError(e)
      // 404: the session finished between reading mySessionId and sending; benign race.
      if (statusCode === 404) return
      lastError.value = message
    }
  }

  function clearLastError() {
    lastError.value = null
    budgetExhausted.value = false
    freeAllowanceExhausted.value = false
  }

  return {
    activeSessions,
    mySession,
    mySessionId,
    otherSessions,
    submitting,
    lastError: readonly(lastError),
    budgetExhausted: readonly(budgetExhausted),
    freeAllowanceExhausted: readonly(freeAllowanceExhausted),
    lastResponse: readonly(lastResponse),
    lastOutcome: readonly(lastOutcome),
    pendingConfirmation,
    answeringConfirmation: readonly(answeringConfirmation),
    prompt,
    abort,
    answerConfirmation,
    clearLastError
  }
}
