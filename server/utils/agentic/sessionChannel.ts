import { nanoid } from 'nanoid'
import { useValkey } from '../valkey'
import type { ToolStatusPhase } from './toolContext'

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
// The client polls `GET /api/ai/sessions/:sessionId` (initiator only) and
// answers confirmations through `POST …/confirm`.
//
// Storage is Valkey so a poll or an answer that lands on another app
// instance still works. One key per field, each written by exactly one
// party, so concurrent writes never read-modify-write the same value.
// Keys outlive the session by `CHANNEL_TTL_MS` so the client can pick up
// the final answer / error after the AI client has left the document.
//
// Failure polarity: status / response writes are best-effort (a Valkey
// blip only hides progress text). A confirmation that cannot be stored
// or read is DENIED — the gate fails closed.

export const CHANNEL_TTL_MS = 15 * 60_000
/** How long the loop waits for an answer before treating it as "deny". */
export const CONFIRMATION_TIMEOUT_MS = 90_000
const ANSWER_POLL_MS = 300

export interface ChannelStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
  /** Set only when the key is absent. Resolves true when it was written. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>
  del(key: string): Promise<void>
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
  message: string | null
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
  return { phase: v.phase, message: typeof v.message === 'string' ? v.message : null }
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
  console.warn(`[ai/session-channel] ${what} failed: ${e instanceof Error ? e.message : String(e)}`)
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
  }

  async setStatus(status: ChannelStatus): Promise<void> {
    try {
      await this.store.set(statusKey(this.sessionId), JSON.stringify(status), CHANNEL_TTL_MS)
    } catch (e) {
      logChannelError('status', e)
    }
  }

  async setResponse(response: ChannelResponse): Promise<void> {
    try {
      await this.store.set(responseKey(this.sessionId), JSON.stringify(response), CHANNEL_TTL_MS)
    } catch (e) {
      logChannelError('response', e)
    }
  }

  /**
   * Ask the initiator to allow `request`. Resolves true only on an
   * explicit "allow" within `timeoutMs`; deny, timeout, abort and any
   * storage error resolve false.
   */
  async requestConfirmation(
    request: ConfirmationRequest,
    signal: AbortSignal,
    timeoutMs: number = CONFIRMATION_TIMEOUT_MS
  ): Promise<boolean> {
    const id = nanoid(16)
    const expiresAt = this.now() + timeoutMs
    const pending: PendingConfirmation = { id, tool: request.tool, target: request.target, expiresAt }
    try {
      await this.store.set(confirmKey(this.sessionId), JSON.stringify(pending), CHANNEL_TTL_MS)
    } catch (e) {
      logChannelError('confirmation request', e)
      return false
    }
    try {
      return await this.waitForAnswer(id, expiresAt, signal)
    } finally {
      try {
        await this.store.del(confirmKey(this.sessionId))
      } catch (e) {
        logChannelError('confirmation cleanup', e)
      }
    }
  }

  private async waitForAnswer(id: string, expiresAt: number, signal: AbortSignal): Promise<boolean> {
    while (!signal.aborted && this.now() < expiresAt) {
      let raw: string | null
      try {
        raw = await this.store.get(answerKey(this.sessionId, id))
      } catch (e) {
        logChannelError('confirmation answer read', e)
        return false
      }
      if (raw === 'allow') return true
      if (raw === 'deny') return false
      await sleep(ANSWER_POLL_MS, signal)
    }
    return false
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

/**
 * Record the initiator's answer for the pending confirmation `confirmationId`.
 * Returns false when no such confirmation is pending (expired, answered,
 * or a stale id) — the first answer wins.
 */
export async function answerSessionConfirmation(
  sessionId: string,
  confirmationId: string,
  allow: boolean,
  store: ChannelStore = valkeyChannelStore,
  now: () => number = Date.now
): Promise<boolean> {
  const pending = readConfirmation(await store.get(confirmKey(sessionId)))
  if (!pending || pending.id !== confirmationId || pending.expiresAt <= now()) return false
  return store.setIfAbsent(answerKey(sessionId, confirmationId), allow ? 'allow' : 'deny', CHANNEL_TTL_MS)
}

/** In-memory store for unit tests and the test seam. */
export function createMemoryChannelStore(): ChannelStore & { keys(): string[] } {
  const data = new Map<string, string>()
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
    keys() {
      return [...data.keys()]
    }
  }
}
