import type { Awareness } from 'y-protocols/awareness'
import type { EditorSelectionSnapshot } from '~~/shared/types/editorSelection'

export interface UseAIOptions {
  /**
   * Optional callback invoked at prompt-submit time to snapshot the
   * user's current caret or selection. The result is shipped alongside
   * the prompt so the server can wrap it with `<editor_state>` context
   * for the model. Called lazily (only when a prompt is actually sent),
   * so a costly read is fine.
   */
  getEditorSelection?: () => EditorSelectionSnapshot
}

export interface AiSessionInfo {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  prompt: string
  // Known phases: 'thinking' | 'tool' | 'editing' | 'done' | 'error'.
  // The wider `string` accepts upstream phase additions (e.g. provider-
  // specific stages from the runLoop) without forcing this union to drift.
  phase: string
  message: string | null
  /**
   * Set when the session was triggered by an `@ai` mention in a
   * comment thread — carries the thread id so the comments panel can
   * render a "AI is working on this thread" indicator on the matching
   * card. Undefined for normal prompt-bar / selection-popup sessions.
   */
  commentThreadId?: string | null
  /**
   * Latest non-document response from the AI for this session, set by
   * the `message_to_user` tool. The frontend's response panel renders
   * this above the prompt bar — auto-collapsed after 2s when
   * `isQuestion` is false, sticky when true. Replaced (not appended) on
   * every new call. Null when the AI hasn't sent a message_to_user
   * this session.
   */
  aiResponse?: { message: string, isQuestion: boolean, ts: number } | null
}

/** Response surface for the AI prompt bar's response panel. */
export interface AiResponseEntry {
  /** Identifier of the session that produced this response. */
  sessionId: string
  /** Body — short text or lightweight markdown, max 600 chars from the server. */
  message: string
  /** Sticky-on-screen when true; auto-collapses when false. */
  isQuestion: boolean
  /** Server-stamped wall-clock ms; drives dedup + the 2s collapse timer. */
  ts: number
}

/**
 * Exposes AI prompt / abort actions and reactive state derived from Y.js
 * awareness. The AI joins the document as its own Y.js client, so every
 * tab naturally sees the AI "user" appear, change status, and leave.
 *
 * The `editorSelection` override is consumed by the bottom prompt bar so
 * cursor / selection state flows through to the server's `<editor_state>`
 * wrapper, letting the agentic loop pick the right edit tool.
 */
export function useAI(docId: Ref<string>, awareness: Awareness, options: UseAIOptions = {}) {
  const { loggedIn, user: sessionUser } = useUserSession()

  // All active AI sessions on this doc, derived from awareness entries that
  // advertise `isAI: true` + an `aiSession` metadata block.
  const activeSessions = ref<AiSessionInfo[]>([])

  function refresh() {
    const list: AiSessionInfo[] = []
    for (const state of awareness.getStates().values()) {
      const user = state?.user
      const ai = state?.aiSession
      const status = state?.aiStatus
      if (!user?.isAI || !ai?.sessionId) continue
      const rawResp = state?.aiResponse
      const aiResponse = rawResp
        && typeof rawResp.message === 'string'
        && typeof rawResp.ts === 'number'
        ? {
            message: rawResp.message,
            isQuestion: rawResp.isQuestion === true,
            ts: rawResp.ts
          }
        : null
      list.push({
        sessionId: ai.sessionId,
        initiatorName: ai.initiatorName,
        initiatorUserId: ai.initiatorUserId,
        prompt: ai.prompt ?? '',
        phase: status?.phase ?? 'thinking',
        message: status?.message ?? null,
        commentThreadId: typeof ai.commentThreadId === 'string' && ai.commentThreadId.length > 0
          ? ai.commentThreadId
          : null,
        aiResponse
      })
    }
    activeSessions.value = list
  }

  awareness.on('change', refresh)
  refresh()
  onUnmounted(() => awareness.off('change', refresh))

  // The current user's session on this doc — used to show Stop button + disable input.
  const mySessionId = computed<string | null>(() => {
    if (!loggedIn.value) return null
    const myId = sessionUser.value?.id
    if (typeof myId !== 'number') return null
    const mine = activeSessions.value.find(s => s.initiatorUserId === myId)
    return mine?.sessionId ?? null
  })

  const mySession = computed<AiSessionInfo | null>(() => {
    if (!mySessionId.value) return null
    return activeSessions.value.find(s => s.sessionId === mySessionId.value) ?? null
  })

  const otherSessions = computed<AiSessionInfo[]>(() => {
    if (!loggedIn.value) return activeSessions.value
    const myId = sessionUser.value?.id
    return activeSessions.value.filter(s => s.initiatorUserId !== myId)
  })

  const submitting = ref(false)
  const lastError = ref<string | null>(null)
  // Separate channel for budget-exhausted (402). The error message
  // alone isn't enough — we want the UI to render an "Upgrade" CTA
  // toast + link-to-pricing, which is a different control flow from
  // the generic "AI request failed" toast. Set when `/api/ai/prompt`
  // returns 402; cleared whenever a fresh request succeeds or
  // `clearLastError()` is called.
  const budgetExhausted = ref(false)

  // Surface errors that happen mid-loop (server-side) back through `lastError` so
  // AIPromptBar can toast them. Awareness clears the session ~2.5s after the error
  // is written, so we must capture the message while it's still visible.
  watch(mySession, (session, prev) => {
    if (session?.phase === 'error' && session.message) {
      lastError.value = session.message.replace(/^Error:\s*/i, '')
    } else if (!session && prev?.phase === 'error') {
      // Session just cleaned up after an error — keep lastError around for the toast.
    }
  })

  // Latched copy of the most recent `message_to_user` response. Awareness
  // disappears with the AI session (~2.5s after `done`), so without this
  // latch the response panel would unmount the moment the loop ends —
  // exactly when the user is reading it. We watch the live awareness
  // entry, snapshot any fresh `aiResponse` into `lastResponse`, and let
  // it persist until either the next response replaces it or the user
  // dismisses it manually. New responses are detected by `(sessionId, ts)`
  // so identical bodies in different sessions don't collide and re-emits
  // within the same session bump the timestamp.
  const lastResponse = ref<AiResponseEntry | null>(null)
  watch(mySession, (session) => {
    if (!session) return
    const r = session.aiResponse
    if (!r) return
    const cur = lastResponse.value
    if (cur?.sessionId === session.sessionId && cur.ts === r.ts) return
    lastResponse.value = {
      sessionId: session.sessionId,
      message: r.message,
      isQuestion: r.isQuestion,
      ts: r.ts
    }
  }, { deep: true })

  // No public eviction handler today: the response panel's × collapses
  // to the pill (`expanded=false` inside the panel) without clearing
  // `lastResponse`, so the user can re-open the most recent reply via
  // the pill at any time. The latched value is only replaced when a
  // fresh `message_to_user` arrives. If we ever need explicit "forget
  // this response" semantics (e.g. long-press, settings toggle), wire
  // a new handler here.

  async function prompt(
    text: string,
    overrides?: { editorSelection?: EditorSelectionSnapshot }
  ): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed || submitting.value || mySessionId.value) return false
    submitting.value = true
    lastError.value = null
    budgetExhausted.value = false
    // Prefer the call-site override (used by the selection popup to
    // pass a pre-captured range snapshot) — falls back to the lazily
    // computed default from `options.getEditorSelection`. `undefined`
    // still ships happily; the server treats absence as `kind: 'none'`.
    const editorSelection = overrides?.editorSelection ?? options.getEditorSelection?.()
    try {
      await $fetch<{ sessionId: string }>('/api/ai/prompt', {
        method: 'POST',
        body: { docId: docId.value, prompt: trimmed, editorSelection }
      })
      return true
    } catch (e) {
      const err = e as {
        statusCode?: number
        status?: number
        data?: { statusCode?: number, message?: string }
        message?: string
      }
      const code = err.statusCode ?? err.status ?? err.data?.statusCode
      if (code === 402) {
        // Budget-exhausted. Flip the flag so the prompt-bar toast
        // renders the upgrade CTA variant.
        budgetExhausted.value = true
      }
      lastError.value = err.data?.message || err.message || 'Request failed'
      return false
    } finally {
      submitting.value = false
    }
  }

  async function abort(): Promise<void> {
    const id = mySessionId.value
    if (!id) return
    try {
      await $fetch('/api/ai/abort', {
        method: 'POST',
        body: { sessionId: id }
      })
    } catch (e) {
      const err = e as { statusCode?: number, data?: { statusCode?: number, message?: string }, message?: string }
      // 404 = session already finished on the server between us reading mySessionId
      // and sending the request. That's a benign race — treat it as success.
      if (err?.statusCode === 404 || err?.data?.statusCode === 404) return
      lastError.value = err.data?.message || err.message || 'Abort failed'
    }
  }

  // Exposed for consumers as a readonly ref plus an explicit `clearLastError`
  // helper. Previously the component mutated `lastError.value = null` directly,
  // which worked but gave no visible API contract and made it easy for the
  // error to stick around if a new caller forgot to clear it. Now the intent is
  // explicit: callers read `lastError`, show a toast, then call `clearLastError()`.
  function clearLastError() {
    lastError.value = null
    budgetExhausted.value = false
  }

  return {
    activeSessions,
    mySession,
    mySessionId,
    otherSessions,
    submitting,
    lastError: readonly(lastError),
    budgetExhausted: readonly(budgetExhausted),
    lastResponse: readonly(lastResponse),
    prompt,
    abort,
    clearLastError
  }
}
