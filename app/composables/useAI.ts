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
  /** Poll cadence for the initiator's private session status (ms). */
  pollIntervalMs?: number
}

/**
 * What EVERY participant of the document can see about an AI session
 * (from Y.js awareness): who started it, its coarse phase, and the
 * comment thread for `@ai` sessions. The prompt, status text and
 * answers are private to the initiator — see `MyAiSessionInfo`.
 */
export interface AiSessionInfo {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  // Known phases: 'thinking' | 'tool' | 'editing' | 'done' | 'error'.
  // The wider `string` accepts upstream phase additions without forcing
  // this union to drift.
  phase: string
  /**
   * Set when the session was triggered by an `@ai` mention in a
   * comment thread — carries the thread id so the comments panel can
   * render a "AI is working on this thread" indicator on the matching
   * card. Undefined for normal prompt-bar / selection-popup sessions.
   */
  commentThreadId?: string | null
}

/** A confirmation the server is waiting for (taint gate). */
export interface AiConfirmationRequest {
  id: string
  /** Tool the AI wants to run (`view_other_document`, `web_search`, …). */
  tool: string
  /** Human-readable target: document title, query, URL, filename. */
  target: string | null
  /** Server wall-clock ms after which an unanswered request counts as "deny". */
  expiresAt: number
}

/**
 * The initiator's own session: the public fields plus what only they
 * receive through `GET /api/ai/sessions/:id` (prompt, status message,
 * pending confirmation).
 */
export interface MyAiSessionInfo extends AiSessionInfo {
  prompt: string
  message: string | null
  confirmation: AiConfirmationRequest | null
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

/** Shape of `GET /api/ai/sessions/:sessionId`. */
interface PrivateSessionStatus {
  sessionId: string
  prompt: string
  phase: string
  message: string | null
  response: { message: string, isQuestion: boolean, ts: number } | null
  confirmation: AiConfirmationRequest | null
}

const DEFAULT_POLL_MS = 600

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function statusCodeOf(e: unknown): number | undefined {
  if (!isRecord(e)) return undefined
  if (typeof e.statusCode === 'number') return e.statusCode
  if (typeof e.status === 'number') return e.status
  return undefined
}

/**
 * Exposes AI prompt / abort / confirm actions and reactive session state.
 *
 * Two sources:
 *   - Y.js awareness — the AI joins the document as its own client, so
 *     every tab sees the AI appear, change phase and leave. Only
 *     public fields ride there.
 *   - The initiator's private channel — while I have a session, the
 *     composable polls `GET /api/ai/sessions/:id` for the prompt, the
 *     live status text, `message_to_user` answers and confirmation
 *     requests ("markoto wants to read 'Q3 plan'"), and answers those
 *     through `POST …/confirm`.
 *
 * The `editorSelection` override is consumed by the bottom prompt bar so
 * cursor / selection state flows through to the server's `<editor_state>`
 * wrapper, letting the agentic loop pick the right edit tool.
 */
export function useAI(docId: Ref<string>, awareness: Awareness, options: UseAIOptions = {}) {
  const { loggedIn, user: sessionUser } = useUserSession()
  const { refresh: refreshAiAvailability } = useAiAvailability()
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS

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
        phase: status?.phase ?? 'thinking',
        commentThreadId: typeof ai.commentThreadId === 'string' && ai.commentThreadId.length > 0
          ? ai.commentThreadId
          : null
      })
    }
    activeSessions.value = list
  }

  awareness.on('change', refresh)
  refresh()

  // The current user's session on this doc — used to show Stop button + disable input.
  const mySessionId = computed<string | null>(() => {
    if (!loggedIn.value) return null
    const myId = sessionUser.value?.id
    if (typeof myId !== 'number') return null
    const mine = activeSessions.value.find(s => s.initiatorUserId === myId)
    return mine?.sessionId ?? null
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

  // ─── Private status channel ───────────────────────────────────────
  //
  // `privateStatus` is the latest snapshot for the session I'm tracking.
  // Tracking starts as soon as `/api/ai/prompt` returns a session id
  // (before the AI client shows up in awareness) or when awareness shows
  // a session of mine (e.g. an `@ai` comment I posted). When the session
  // leaves awareness we fetch once more so the final answer / error isn't
  // lost, then stop.
  const privateStatus = ref<PrivateSessionStatus | null>(null)
  const startedSessionId = ref<string | null>(null)
  const trackedSessionId = computed(() => mySessionId.value ?? startedSessionId.value)

  const lastResponse = ref<AiResponseEntry | null>(null)
  let lastErrorSessionId: string | null = null

  function applyStatus(s: PrivateSessionStatus) {
    privateStatus.value = s
    const r = s.response
    if (r) {
      const cur = lastResponse.value
      if (cur?.sessionId !== s.sessionId || cur.ts !== r.ts) {
        lastResponse.value = { sessionId: s.sessionId, message: r.message, isQuestion: r.isQuestion, ts: r.ts }
      }
    }
    // Surface errors that happen mid-loop (server-side) through
    // `lastError` so AIPromptBar can toast them — once per session.
    if (s.phase === 'error' && s.message && lastErrorSessionId !== s.sessionId) {
      lastErrorSessionId = s.sessionId
      lastError.value = s.message.replace(/^Error:\s*/i, '')
    }
  }

  /** One fetch; resolves false when the session is gone (404) so polling stops. */
  async function fetchStatus(sid: string): Promise<boolean> {
    try {
      const s = await $fetch<PrivateSessionStatus>(`/api/ai/sessions/${encodeURIComponent(sid)}`)
      if (trackedSessionId.value === sid || mySessionId.value === null) applyStatus(s)
      return true
    } catch (e) {
      return statusCodeOf(e) !== 404
    }
  }

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollingFor: string | null = null

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    pollingFor = null
  }

  function schedulePoll(sid: string) {
    pollTimer = setTimeout(async () => {
      if (pollingFor !== sid) return
      const alive = await fetchStatus(sid)
      if (pollingFor !== sid) return
      // Gone, or finished without (still) being in awareness — e.g. the
      // session failed before the AI could join the document.
      const finished = privateStatus.value?.sessionId === sid
        && (privateStatus.value.phase === 'done' || privateStatus.value.phase === 'error')
        && mySessionId.value !== sid
      if (!alive || finished) {
        if (startedSessionId.value === sid) startedSessionId.value = null
        stopPolling()
        return
      }
      schedulePoll(sid)
    }, pollMs)
  }

  watch(trackedSessionId, (sid, prev) => {
    stopPolling()
    if (prev && !sid) {
      // Session left awareness: one last read for its final answer/error.
      void fetchStatus(prev)
      privateStatus.value = null
      return
    }
    if (!sid) return
    privateStatus.value = null
    pollingFor = sid
    void fetchStatus(sid)
    schedulePoll(sid)
  }, { immediate: true })

  // Once awareness shows the session I started, awareness drives tracking.
  watch(mySessionId, (sid) => {
    if (sid && startedSessionId.value === sid) startedSessionId.value = null
  })

  onUnmounted(() => {
    awareness.off('change', refresh)
    stopPolling()
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
      await $fetch(`/api/ai/sessions/${encodeURIComponent(sid)}/confirm`, {
        method: 'POST',
        body: { confirmationId: c.id, allow }
      })
    } catch (e) {
      // 409 = already answered / timed out — the next poll shows the
      // current state; anything else is worth a toast.
      if (statusCodeOf(e) !== 409) {
        const msg = isRecord(e) && typeof e.message === 'string' ? e.message : 'Request failed'
        lastError.value = msg
      }
    } finally {
      answeringConfirmation.value = false
      // Hide the answered request right away; the poll confirms.
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
    budgetExhausted.value = false
    // Prefer the call-site override (used by the selection popup to
    // pass a pre-captured range snapshot) — falls back to the lazily
    // computed default from `options.getEditorSelection`. `undefined`
    // still ships happily; the server treats absence as `kind: 'none'`.
    const editorSelection = overrides?.editorSelection ?? options.getEditorSelection?.()
    try {
      const res = await $fetch<{ sessionId: string }>('/api/ai/prompt', {
        method: 'POST',
        body: { docId: docId.value, prompt: trimmed, editorSelection }
      })
      if (typeof res?.sessionId === 'string') startedSessionId.value = res.sessionId
      return true
    } catch (e) {
      const err = e as {
        statusCode?: number
        status?: number
        data?: { statusCode?: number, message?: string, code?: string }
        message?: string
      }
      const code = err.statusCode ?? err.status ?? err.data?.statusCode
      if (err.data?.code === 'ai/provider-missing') {
        // Availability snapshot was stale (provider removed in another
        // tab, instance default dropped) — refresh so the prompt bar
        // swaps to the "Add your API key" call-to-action.
        void refreshAiAvailability()
      }
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
  // helper: callers read `lastError`, show a toast, then call `clearLastError()`.
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
    pendingConfirmation,
    answeringConfirmation: readonly(answeringConfirmation),
    prompt,
    abort,
    answerConfirmation,
    clearLastError
  }
}
