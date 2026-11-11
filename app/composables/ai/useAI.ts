import { onScopeDispose } from 'vue'
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
  /** Poll cadence for the fallback polling of the private session status (ms). */
  pollIntervalMs?: number
  /**
   * Opens the push stream (`GET /api/ai/sessions/:id/stream`). Defaults
   * to the browser's `EventSource`; `null` = no streaming, poll only
   * (also what happens where `EventSource` doesn't exist).
   */
  createEventSource?: ((url: string) => AiEventSource) | null
}

/** The slice of `EventSource` the composable uses (injectable for tests). */
export interface AiEventSource {
  readonly readyState: number
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  onerror: ((event: Event) => void) | null
  close(): void
}

/** `EventSource.CLOSED` — the browser gave up (HTTP error, wrong content type). */
const EVENT_SOURCE_CLOSED = 2
/** Consecutive stream errors without a message before falling back to polling. */
const STREAM_MAX_ERRORS = 3

function defaultEventSourceFactory(): ((url: string) => AiEventSource) | null {
  if (typeof EventSource === 'undefined') return null
  return url => new EventSource(url)
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

/** How my most recent session ended — `error` is what the failure toast reports. */
export interface AiSessionOutcome {
  sessionId: string
  phase: 'done' | 'error'
  message: string | null
}

/** Shape of `GET /api/ai/sessions/:sessionId` (and of the stream's `status` events). */
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

function parseStatusEvent(data: unknown): PrivateSessionStatus | null {
  if (typeof data !== 'string') return null
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return null
  }
  if (!isRecord(v) || typeof v.sessionId !== 'string' || typeof v.phase !== 'string') return null
  const response = isRecord(v.response) && typeof v.response.message === 'string' && typeof v.response.ts === 'number'
    ? { message: v.response.message, isQuestion: v.response.isQuestion === true, ts: v.response.ts }
    : null
  const c = v.confirmation
  const confirmation = isRecord(c) && typeof c.id === 'string' && typeof c.tool === 'string' && typeof c.expiresAt === 'number'
    ? { id: c.id, tool: c.tool, target: typeof c.target === 'string' ? c.target : null, expiresAt: c.expiresAt }
    : null
  return {
    sessionId: v.sessionId,
    prompt: typeof v.prompt === 'string' ? v.prompt : '',
    phase: v.phase,
    message: typeof v.message === 'string' ? v.message : null,
    response,
    confirmation
  }
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
  const { loggedIn, user: sessionUser } = useUserSession()
  const { refresh: refreshAiAvailability } = useAiAvailability()
  const { extractError } = useErrorHandler()
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const createEventSource = options.createEventSource === undefined
    ? defaultEventSourceFactory()
    : options.createEventSource

  // Derived from awareness entries with `isAI: true` + an `aiSession` block.
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
  // Set on a 402 from `/api/ai/prompt` so the UI shows the upgrade CTA instead
  // of the generic failure toast. Cleared on the next prompt or `clearLastError()`.
  const budgetExhausted = ref(false)
  // The shared monthly free-tier pool is used up (402
  // `ai/free-allowance-exhausted`) — distinct from the user's own points.
  const freeAllowanceExhausted = ref(false)

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
  // Terminal phase of my latest session; cleared when the next one
  // starts. Mirrored onto the prompt bar so flow tests can tell a
  // finished session from one that ended in an error.
  const lastOutcome = ref<AiSessionOutcome | null>(null)
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
    if (s.phase === 'done' || s.phase === 'error') {
      lastOutcome.value = { sessionId: s.sessionId, phase: s.phase === 'error' ? 'error' : 'done', message: s.message }
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
      const s = await apiFetch('/api/ai/sessions/:sessionId', { path: { sessionId: sid } })
      if (trackedSessionId.value === sid || mySessionId.value === null) applyStatus(s)
      return true
    } catch (e) {
      return statusCodeOf(e) !== 404
    }
  }

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollingFor: string | null = null
  let stream: AiEventSource | null = null

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    pollingFor = null
    if (stream) {
      stream.onerror = null
      stream.close()
    }
    stream = null
  }

  /** The tracked session is over — stop following it. */
  function finishTracking(sid: string) {
    if (startedSessionId.value === sid) startedSessionId.value = null
    stopPolling()
  }

  /**
   * Follow `sid` through the push stream. Falls back to polling when the
   * browser gives up on it (HTTP error — e.g. a proxy that refuses SSE)
   * or it fails `STREAM_MAX_ERRORS` times in a row without delivering.
   */
  function startStream(sid: string, factory: (url: string) => AiEventSource) {
    let es: AiEventSource
    try {
      es = factory(`/api/ai/sessions/${encodeURIComponent(sid)}/stream`)
    } catch {
      startPolling(sid)
      return
    }
    stream = es
    let errors = 0
    es.addEventListener('status', (ev) => {
      if (pollingFor !== sid) return
      errors = 0
      const s = parseStatusEvent(ev.data)
      if (s && (trackedSessionId.value === sid || mySessionId.value === null)) applyStatus(s)
    })
    es.addEventListener('end', () => {
      if (pollingFor !== sid) return
      finishTracking(sid)
    })
    es.onerror = () => {
      if (pollingFor !== sid) return
      errors++
      if (es.readyState !== EVENT_SOURCE_CLOSED && errors < STREAM_MAX_ERRORS) return
      // Give up on the stream for this session; polling still works.
      es.onerror = null
      es.close()
      stream = null
      startPolling(sid)
    }
  }

  function startPolling(sid: string) {
    void fetchStatus(sid)
    schedulePoll(sid)
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
        finishTracking(sid)
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
    if (lastOutcome.value?.sessionId !== sid) lastOutcome.value = null
    pollingFor = sid
    if (createEventSource) startStream(sid, createEventSource)
    else startPolling(sid)
  }, { immediate: true })

  // Once awareness shows the session I started, awareness drives tracking.
  watch(mySessionId, (sid) => {
    if (sid && startedSessionId.value === sid) startedSessionId.value = null
  })

  // Scope disposal (= component unmount in the editor) closes the stream
  // and stops polling; `onScopeDispose` also covers callers that run the
  // composable in a detached effect scope (tests).
  onScopeDispose(() => {
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
      await apiFetch('/api/ai/sessions/:sessionId/confirm', {
        method: 'post',
        path: { sessionId: sid },
        body: { confirmationId: c.id, allow }
      })
    } catch (e) {
      // 409 = already answered / timed out — the next update shows the
      // current state; anything else is worth a toast.
      if (statusCodeOf(e) !== 409) {
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
      return true
    } catch (e) {
      const { statusCode, code, message } = extractError(e)
      if (code === 'ai/provider-missing') {
        // Availability snapshot was stale (provider removed in another
        // tab, instance default dropped) — refresh so the prompt bar
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
