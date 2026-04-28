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
  phase: 'thinking' | 'tool' | 'editing' | 'done' | 'error' | string
  message: string | null
  /**
   * Set when the session was triggered by an `@ai` mention in a
   * comment thread — carries the thread id so the comments panel can
   * render a "AI is working on this thread" indicator on the matching
   * card. Undefined for normal prompt-bar / selection-popup sessions.
   */
  commentThreadId?: string | null
}

/**
 * Exposes AI prompt / abort actions and reactive state derived from Y.js
 * awareness. Gemini joins the document as its own client, so every tab
 * naturally sees the AI "user" appear, change status, and leave.
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
      list.push({
        sessionId: ai.sessionId,
        initiatorName: ai.initiatorName,
        initiatorUserId: ai.initiatorUserId,
        prompt: ai.prompt ?? '',
        phase: status?.phase ?? 'thinking',
        message: status?.message ?? null,
        commentThreadId: typeof ai.commentThreadId === 'string' && ai.commentThreadId.length > 0
          ? ai.commentThreadId
          : null
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
    const myId = sessionUser.value?.id as number | undefined
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
    prompt,
    abort,
    clearLastError
  }
}
