import type { JobConfirmationDetails } from '~~/shared/ai/jobConfirmation'
import type { ReplaceConfirmationDetails } from '~~/shared/ai/replaceConfirmation'
import { onScopeDispose } from 'vue'
import type { AiConfirmationRequest, AiEventSource, AiResponseEntry, AiSessionOutcome } from '~/types/ai/session'
import { parseAiStatusStep, type AiStatusStep } from '~~/shared/ai/statusSteps'

/**
 * The initiator's private channel of an AI session: while I have a session,
 * follow the push stream `GET /api/ai/sessions/:id/stream` (Server-Sent
 * Events) for the prompt, the live status text, `message_to_user` answers
 * and confirmation requests. If the stream can't be opened or keeps failing
 * it falls back to polling `GET /api/ai/sessions/:id`. Part of `useAI`.
 */

/** `EventSource.CLOSED`: the browser gave up (HTTP error, wrong content type). */
const EVENT_SOURCE_CLOSED = 2
/** Consecutive stream errors without a message before falling back to polling. */
const STREAM_MAX_ERRORS = 3

/** Shape of `GET /api/ai/sessions/:sessionId` (and of the stream's `status` events). */
interface PrivateSessionStatus {
  sessionId: string
  prompt: string
  phase: string
  message: string | null
  step: AiStatusStep | null
  response: { message: string, isQuestion: boolean, ts: number } | null
  confirmation: AiConfirmationRequest | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** The details of a job or replace confirmation (the server validated them). */
function confirmationDetails(c: Record<string, unknown>): Pick<AiConfirmationRequest, 'kind' | 'job' | 'replace'> {
  if (c.kind === 'job' && isRecord(c.job)) return { kind: 'job', job: c.job as unknown as JobConfirmationDetails }
  if (c.kind === 'replace' && isRecord(c.replace) && Array.isArray(c.replace.forms)) return { kind: 'replace', replace: c.replace as unknown as ReplaceConfirmationDetails }
  return {}
}

function parseConfirmation(c: unknown): AiConfirmationRequest | null {
  if (!isRecord(c) || typeof c.id !== 'string' || typeof c.tool !== 'string' || typeof c.expiresAt !== 'number') return null
  return {
    id: c.id,
    tool: c.tool,
    target: typeof c.target === 'string' ? c.target : null,
    expiresAt: c.expiresAt,
    ...confirmationDetails(c)
  }
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
  const confirmation = parseConfirmation(v.confirmation)
  return {
    sessionId: v.sessionId,
    prompt: typeof v.prompt === 'string' ? v.prompt : '',
    phase: v.phase,
    message: typeof v.message === 'string' ? v.message : null,
    step: parseAiStatusStep(v.step),
    response,
    confirmation
  }
}

export function aiErrorStatus(e: unknown): number | undefined {
  if (!isRecord(e)) return undefined
  if (typeof e.statusCode === 'number') return e.statusCode
  if (typeof e.status === 'number') return e.status
  return undefined
}

interface TrackingOptions {
  /** My session as awareness shows it. */
  mySessionId: Ref<string | null>
  /** Where a session's mid-loop error is reported (once per session). */
  lastError: Ref<string | null>
  pollMs: number
  createEventSource: ((url: string) => AiEventSource) | null
  /** Renders a status step in the UI language (the error toast's text). */
  stepText: (step: AiStatusStep) => string
}

export function useAiSessionTracking({ mySessionId, lastError, pollMs, createEventSource, stepText }: TrackingOptions) {
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
  // Sessions started from the prompt bar: they owe the user an answer. A
  // comment-trigger session answers in its thread instead.
  const promptSessions = new Set<string>()
  // Terminal phase of my latest session; cleared when the next one
  // starts. Mirrored onto the prompt bar so flow tests can tell a
  // finished session from one that ended in an error.
  const lastOutcome = ref<AiSessionOutcome | null>(null)
  let lastErrorSessionId: string | null = null

  /**
   * A session that ended: a summary written at a step / time limit gets a
   * notice above it, and a prompt-bar session that ended "done" without
   * any answer gets the client's own "Done" line, so the panel never keeps
   * showing the previous session's answer as if it were this one's.
   */
  function settleResponse(s: PrivateSessionStatus) {
    const cur = lastResponse.value
    const own = cur?.sessionId === s.sessionId ? cur : null
    if (own && !own.synthetic && s.step?.key === 'stoppedEarly' && !own.notice) {
      lastResponse.value = { ...own, notice: stepText(s.step) }
      return
    }
    if (!own && s.phase === 'done' && promptSessions.has(s.sessionId)) {
      lastResponse.value = { sessionId: s.sessionId, message: stepText({ key: 'doneNoAnswer' }), isQuestion: false, ts: Date.now(), synthetic: true }
    }
  }

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
      settleResponse(s)
    }
    // Surface errors that happen mid-loop (server-side) through
    // `lastError` so AIPromptBar can toast them, once per session.
    if (s.phase === 'error' && (s.step || s.message) && lastErrorSessionId !== s.sessionId) {
      lastErrorSessionId = s.sessionId
      lastError.value = s.step ? stepText(s.step) : (s.message ?? '').replace(/^Error:\s*/i, '')
    }
  }

  /** One fetch; resolves false when the session is gone (404) so polling stops. */
  async function fetchStatus(sid: string): Promise<boolean> {
    try {
      const s = await apiFetch('/api/ai/sessions/:sessionId', { path: { sessionId: sid } })
      if (trackedSessionId.value === sid || mySessionId.value === null) applyStatus(s)
      return true
    } catch (e) {
      return aiErrorStatus(e) !== 404
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

  /** The tracked session is over, stop following it. */
  function finishTracking(sid: string) {
    if (startedSessionId.value === sid) startedSessionId.value = null
    stopPolling()
  }

  /**
   * Follow `sid` through the push stream. Falls back to polling when the
   * browser gives up on it (HTTP error, e.g. a proxy that refuses SSE)
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
    pollTimer = setTimeout(() => void poll(sid), pollMs)
  }

  async function poll(sid: string) {
    if (pollingFor !== sid) return
    const alive = await fetchStatus(sid)
    if (pollingFor !== sid) return
    // Gone, or finished without (still) being in awareness, e.g. the
    // session failed before the AI could join the document.
    const finished = privateStatus.value?.sessionId === sid
      && (privateStatus.value.phase === 'done' || privateStatus.value.phase === 'error')
      && mySessionId.value !== sid
    if (!alive || finished) {
      finishTracking(sid)
      return
    }
    schedulePoll(sid)
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
  onScopeDispose(stopPolling)

  /** A prompt was sent: the previous answer goes, and `sid` (once known) owes an answer. */
  function startPrompt(sid?: string) {
    lastResponse.value = null
    if (sid) promptSessions.add(sid)
  }

  return { privateStatus, startedSessionId, lastResponse, lastOutcome, startPrompt }
}
