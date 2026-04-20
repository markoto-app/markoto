import type { Awareness } from 'y-protocols/awareness'

export interface AiSessionInfo {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  prompt: string
  // 'prompt' = full agentic loop (drives the bottom prompt bar's
  // animation). 'rewrite' = inline selection rewrite (drives the
  // selection popup's animation). Older sessions without the field
  // default to 'prompt' to preserve legacy behavior.
  kind: 'prompt' | 'rewrite'
  phase: 'thinking' | 'tool' | 'editing' | 'done' | 'error' | string
  message: string | null
}

/**
 * Exposes AI prompt / rewrite / abort actions and reactive state derived from
 * Y.js awareness. Gemini joins the document as its own client, so every tab
 * naturally sees the AI "user" appear, change status, and leave.
 */
export function useAI(docId: Ref<string>, awareness: Awareness) {
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
        kind: ai.kind === 'rewrite' ? 'rewrite' : 'prompt',
        phase: status?.phase ?? 'thinking',
        message: status?.message ?? null
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

  async function prompt(text: string): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed || submitting.value || mySessionId.value) return false
    submitting.value = true
    lastError.value = null
    try {
      await $fetch<{ sessionId: string }>('/api/ai/prompt', {
        method: 'POST',
        body: { docId: docId.value, prompt: trimmed }
      })
      return true
    } catch (e) {
      const err = e as { data?: { message?: string }, message?: string }
      lastError.value = err.data?.message || err.message || 'Request failed'
      return false
    } finally {
      submitting.value = false
    }
  }

  async function rewrite(params: {
    selectionText: string
    selectionFrom: number
    selectionTo: number
    relFrom?: unknown
    relTo?: unknown
    instruction: string
  }): Promise<boolean> {
    lastError.value = null
    try {
      await $fetch('/api/ai/rewrite', {
        method: 'POST',
        body: {
          docId: docId.value,
          selectionText: params.selectionText,
          selectionFrom: params.selectionFrom,
          selectionTo: params.selectionTo,
          relFrom: params.relFrom,
          relTo: params.relTo,
          prompt: params.instruction
        }
      })
      return true
    } catch (e) {
      const err = e as { data?: { message?: string }, message?: string }
      lastError.value = err.data?.message || err.message || 'Rewrite failed'
      return false
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
  }

  return {
    activeSessions,
    mySession,
    mySessionId,
    otherSessions,
    submitting,
    lastError: readonly(lastError),
    prompt,
    rewrite,
    abort,
    clearLastError
  }
}
