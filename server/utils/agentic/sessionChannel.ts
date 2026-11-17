import { nanoid } from 'nanoid'
import { useValkey, useValkeySubscriber } from '../platform/valkey'
import type { ToolStatusPhase } from './toolContext'
import { MINUTE_MS } from '~~/shared/config/units'
import { useLogger } from '../platform/logger'
import { parseAiStatusStep, type AiStatusStep } from '~~/shared/ai/statusSteps'
import { CONFIRM_NOTE_MAX_LENGTH } from '~~/shared/api/ai'

const log = useLogger('ai-session-channel')

// Initiator-only channel for an AI session.
//
// Y.js awareness reaches EVERY client of a document (read-only viewers
// and anonymous visitors included), so it only carries what everybody
// may see: "markoto is working for <name>" (session id, initiator,
// phase, comment-thread id). Everything else that belongs to the person
// who started the session lives here instead:
//
//   - the prompt text,
//   - live status messages ("Reading 'Q3 plan'…", URLs, search queries),
//   - `message_to_user` answers,
//   - pending confirmation requests + their answers (taint gate, see
//     `crossBoundary.ts`).
//
// The client follows it through the push stream
// `GET /api/ai/sessions/:sessionId/stream` (SSE, initiator only, see
// `sessionStream.ts`), falls back to polling `GET /api/ai/sessions/:id`
// when the stream breaks, and answers confirmations through
// `POST …/confirm`.
//
// Storage is Valkey so a read, a stream or an answer that lands on
// another app instance still works. Every write also PUBLISHes a
// "changed" ping on `ai:session-channel:{sid}:notify` (Valkey pub/sub,
// reaches every instance) so open streams re-read right away. The ping
// carries no data: subscribers re-read the keys, so a lost ping only
// delays an update until the stream's periodic re-read. One key per
// field, each written by exactly one party, so concurrent writes never
// read-modify-write the same value.
// Keys outlive the session by `CHANNEL_TTL_MS` so the client can pick up
// the final answer / error after the AI client has left the document.
//
// Failure polarity: status / response writes are best-effort (a Valkey
// blip only hides progress text). A confirmation that cannot be stored
// or read is DENIED, the gate fails closed.

const CHANNEL_TTL_MS = 15 * MINUTE_MS
/** How long the loop waits for an answer before treating it as "deny". */
const CONFIRMATION_TIMEOUT_MS = 90_000
const ANSWER_POLL_MS = 300

export interface ChannelStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
  /** Set only when the key is absent. Resolves true when it was written. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>
  del(key: string): Promise<void>
  /** Tell open streams of `sessionId` that something changed (best-effort). */
  notify(sessionId: string): Promise<void>
  /** Call `listener` on every change of `sessionId`. Resolves to the unsubscribe function. */
  subscribe(sessionId: string, listener: () => void): Promise<() => void>
}

const notifyChannel = (sid: string) => `ai:session-channel:${sid}:notify`

// One subscriber connection per process, shared by every open stream.
// Listeners are ref-counted per Valkey channel.
const valkeyListeners = new Map<string, Set<() => void>>()
let messageHandlerOn: ReturnType<typeof useValkeySubscriber> | null = null

function installValkeyMessageHandler(): void {
  const sub = useValkeySubscriber()
  if (messageHandlerOn === sub) return
  messageHandlerOn = sub
  sub.on('message', (channel: string) => {
    for (const listener of valkeyListeners.get(channel) ?? []) {
      try {
        listener()
      } catch (e) {
        logChannelError('notify listener', e)
      }
    }
  })
}

export const valkeyChannelStore: ChannelStore = {
  async get(key) {
    return useValkey().get(key)
  },
  async set(key, value, ttlMs) {
    await useValkey().set(key, value, 'PX', ttlMs)
  },
  async setIfAbsent(key, value, ttlMs) {
    const res = await useValkey().set(key, value, 'PX', ttlMs, 'NX')
    return res === 'OK'
  },
  async del(key) {
    await useValkey().del(key)
  },
  async notify(sessionId) {
    try {
      await useValkey().publish(notifyChannel(sessionId), '1')
    } catch (e) {
      logChannelError('notify', e)
    }
  },
  async subscribe(sessionId, listener) {
    installValkeyMessageHandler()
    const channel = notifyChannel(sessionId)
    let set = valkeyListeners.get(channel)
    if (!set) {
      set = new Set()
      valkeyListeners.set(channel, set)
      try {
        await useValkeySubscriber().subscribe(channel)
      } catch (e) {
        valkeyListeners.delete(channel)
        throw e
      }
    }
    set.add(listener)
    return () => {
      const current = valkeyListeners.get(channel)
      if (!current) return
      current.delete(listener)
      if (current.size > 0) return
      valkeyListeners.delete(channel)
      useValkeySubscriber().unsubscribe(channel).catch((e: unknown) => logChannelError('unsubscribe', e))
    }
  }
}

export interface ChannelMeta {
  initiatorUserId: number
  docId: string
  prompt: string
  commentThreadId: string | null
}

export interface ChannelStatus {
  phase: ToolStatusPhase
  /** English text of the status (also the fallback when `step` is null). */
  message: string | null
  /** The status as a code the client renders in the UI language. */
  step: AiStatusStep | null
}

export interface ChannelResponse {
  message: string
  isQuestion: boolean
  ts: number
}

/** What the initiator is asked to allow. `target` is a human-readable label (doc title, query, URL). */
export interface ConfirmationRequest {
  tool: string
  target: string | null
}

/**
 * The initiator's answer. `note` is what they typed with a Deny ("No,
 * search for X instead"): their own words, trimmed and bounded, handed to
 * the model with the decline.
 */
export interface ConfirmationAnswer {
  allowed: boolean
  note: string | null
}

const DENIED: ConfirmationAnswer = { allowed: false, note: null }

/** Trim and bound a decline note; empty → null. */
export function boundConfirmNote(note: string | null | undefined): string | null {
  const trimmed = (note ?? '').trim().slice(0, CONFIRM_NOTE_MAX_LENGTH).trim()
  return trimmed.length > 0 ? trimmed : null
}

// Stored answer values: 'allow', 'deny', or 'deny:' + the note.
const DENY_NOTE_PREFIX = 'deny:'

function readAnswer(raw: string | null): ConfirmationAnswer | null {
  if (raw === 'allow') return { allowed: true, note: null }
  if (raw === 'deny') return DENIED
  if (raw?.startsWith(DENY_NOTE_PREFIX)) return { allowed: false, note: boundConfirmNote(raw.slice(DENY_NOTE_PREFIX.length)) }
  return null
}

export interface PendingConfirmation extends ConfirmationRequest {
  id: string
  expiresAt: number
}

export interface ChannelSnapshot extends ChannelMeta {
  sessionId: string
  status: ChannelStatus | null
  response: ChannelResponse | null
  confirmation: PendingConfirmation | null
}

const PREFIX = 'ai:session-channel'
const metaKey = (sid: string) => `${PREFIX}:${sid}:meta`
const statusKey = (sid: string) => `${PREFIX}:${sid}:status`
const responseKey = (sid: string) => `${PREFIX}:${sid}:response`
const confirmKey = (sid: string) => `${PREFIX}:${sid}:confirm`
const answerKey = (sid: string, cid: string) => `${PREFIX}:${sid}:answer:${cid}`

function parseJson(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const PHASES: readonly ToolStatusPhase[] = ['thinking', 'tool', 'editing', 'done', 'error']
function isPhase(v: unknown): v is ToolStatusPhase {
  return typeof v === 'string' && (PHASES as readonly string[]).includes(v)
}

function readMeta(raw: string | null): ChannelMeta | null {
  const v = parseJson(raw)
  if (!isRecord(v) || typeof v.initiatorUserId !== 'number' || typeof v.docId !== 'string') return null
  return {
    initiatorUserId: v.initiatorUserId,
    docId: v.docId,
    prompt: typeof v.prompt === 'string' ? v.prompt : '',
    commentThreadId: typeof v.commentThreadId === 'string' ? v.commentThreadId : null
  }
}

function readStatus(raw: string | null): ChannelStatus | null {
  const v = parseJson(raw)
  if (!isRecord(v) || !isPhase(v.phase)) return null
  return { phase: v.phase, message: typeof v.message === 'string' ? v.message : null, step: parseAiStatusStep(v.step) }
}

function readResponse(raw: string | null): ChannelResponse | null {
  const v = parseJson(raw)
  if (!isRecord(v) || typeof v.message !== 'string' || typeof v.ts !== 'number') return null
  return { message: v.message, isQuestion: v.isQuestion === true, ts: v.ts }
}

function readConfirmation(raw: string | null): PendingConfirmation | null {
  const v = parseJson(raw)
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.tool !== 'string' || typeof v.expiresAt !== 'number') return null
  return { id: v.id, tool: v.tool, target: typeof v.target === 'string' ? v.target : null, expiresAt: v.expiresAt }
}

function logChannelError(what: string, e: unknown): void {
  log.warn('session channel operation failed', { operation: what, err: e })
}

/**
 * Per-session writer used by the loop process. All writes are
 * best-effort except the confirmation round trip (fail closed).
 */
export class AiSessionChannel {
  constructor(
    readonly sessionId: string,
    private readonly store: ChannelStore = valkeyChannelStore,
    private readonly now: () => number = Date.now
  ) {}

  async open(meta: ChannelMeta): Promise<void> {
    try {
      await this.store.set(metaKey(this.sessionId), JSON.stringify(meta), CHANNEL_TTL_MS)
    } catch (e) {
      logChannelError('open', e)
    }
    await this.store.notify(this.sessionId)
  }

  async setStatus(status: ChannelStatus): Promise<void> {
    try {
      await this.store.set(statusKey(this.sessionId), JSON.stringify(status), CHANNEL_TTL_MS)
    } catch (e) {
      logChannelError('status', e)
      return
    }
    await this.store.notify(this.sessionId)
  }

  async setResponse(response: ChannelResponse): Promise<void> {
    try {
      await this.store.set(responseKey(this.sessionId), JSON.stringify(response), CHANNEL_TTL_MS)
    } catch (e) {
      logChannelError('response', e)
      return
    }
    await this.store.notify(this.sessionId)
  }

  /**
   * Ask the initiator to allow `request`. Resolves allowed only on an
   * explicit "allow" within `timeoutMs`; deny, timeout, abort and any
   * storage error resolve not allowed (a deny may carry the initiator's
   * note).
   */
  async requestConfirmation(
    request: ConfirmationRequest,
    signal: AbortSignal,
    timeoutMs: number = CONFIRMATION_TIMEOUT_MS
  ): Promise<ConfirmationAnswer> {
    const id = nanoid(16)
    const expiresAt = this.now() + timeoutMs
    const pending: PendingConfirmation = { id, tool: request.tool, target: request.target, expiresAt }
    try {
      await this.store.set(confirmKey(this.sessionId), JSON.stringify(pending), CHANNEL_TTL_MS)
    } catch (e) {
      logChannelError('confirmation request', e)
      return DENIED
    }
    await this.store.notify(this.sessionId)
    try {
      return await this.waitForAnswer(id, expiresAt, signal)
    } finally {
      try {
        await this.store.del(confirmKey(this.sessionId))
      } catch (e) {
        logChannelError('confirmation cleanup', e)
      }
      await this.store.notify(this.sessionId)
    }
  }

  private async waitForAnswer(id: string, expiresAt: number, signal: AbortSignal): Promise<ConfirmationAnswer> {
    while (!signal.aborted && this.now() < expiresAt) {
      let raw: string | null
      try {
        raw = await this.store.get(answerKey(this.sessionId, id))
      } catch (e) {
        logChannelError('confirmation answer read', e)
        return DENIED
      }
      const answer = readAnswer(raw)
      if (answer) return answer
      await sleep(ANSWER_POLL_MS, signal)
    }
    return DENIED
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Read everything the initiator may see. Null when the session is unknown / expired. */
export async function readSessionChannel(sessionId: string, store: ChannelStore = valkeyChannelStore): Promise<ChannelSnapshot | null> {
  const [meta, status, response, confirmation] = await Promise.all([
    store.get(metaKey(sessionId)),
    store.get(statusKey(sessionId)),
    store.get(responseKey(sessionId)),
    store.get(confirmKey(sessionId))
  ])
  const parsedMeta = readMeta(meta)
  if (!parsedMeta) return null
  return {
    sessionId,
    ...parsedMeta,
    status: readStatus(status),
    response: readResponse(response),
    confirmation: readConfirmation(confirmation)
  }
}

/** What the initiator receives (GET and stream share the shape). */
export interface SessionView {
  sessionId: string
  docId: string
  prompt: string
  commentThreadId: string | null
  phase: ToolStatusPhase
  message: string | null
  step: AiStatusStep | null
  response: ChannelResponse | null
  confirmation: PendingConfirmation | null
}

export function toSessionView(snapshot: ChannelSnapshot): SessionView {
  return {
    sessionId: snapshot.sessionId,
    docId: snapshot.docId,
    prompt: snapshot.prompt,
    commentThreadId: snapshot.commentThreadId,
    phase: snapshot.status?.phase ?? 'thinking',
    message: snapshot.status?.message ?? null,
    step: snapshot.status?.step ?? null,
    response: snapshot.response,
    confirmation: snapshot.confirmation
  }
}

/**
 * Record the initiator's answer for the pending confirmation `confirmationId`
 * (`note` only with a deny). Returns false when no such confirmation is
 * pending (expired, answered, or a stale id), the first answer wins.
 */
export async function answerSessionConfirmation(
  sessionId: string,
  confirmationId: string,
  answer: { allow: boolean, note?: string | null },
  store: ChannelStore = valkeyChannelStore,
  now: () => number = Date.now
): Promise<boolean> {
  const pending = readConfirmation(await store.get(confirmKey(sessionId)))
  if (!pending || pending.id !== confirmationId || pending.expiresAt <= now()) return false
  // The loop picks the answer up and clears the request; that write
  // notifies the stream.
  const note = answer.allow ? null : boundConfirmNote(answer.note)
  const value = answer.allow ? 'allow' : (note ? `${DENY_NOTE_PREFIX}${note}` : 'deny')
  return store.setIfAbsent(answerKey(sessionId, confirmationId), value, CHANNEL_TTL_MS)
}

/** In-memory store for unit tests and the test seam. */
export function createMemoryChannelStore(): ChannelStore & { keys(): string[] } {
  const data = new Map<string, string>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async setIfAbsent(key, value) {
      if (data.has(key)) return false
      data.set(key, value)
      return true
    },
    async del(key) {
      data.delete(key)
    },
    async notify(sessionId) {
      for (const listener of listeners.get(sessionId) ?? []) listener()
    },
    async subscribe(sessionId, listener) {
      let set = listeners.get(sessionId)
      if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      set.add(listener)
      return () => {
        listeners.get(sessionId)?.delete(listener)
      }
    },
    keys() {
      return [...data.keys()]
    }
  }
}
