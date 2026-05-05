/**
 * Live-dictation WebSocket frame contracts.
 *
 * Pins the wire shape for `/api/ai/dictate`. Both the server (under
 * `server/routes/api/ai/dictate.ts`) and the client (under
 * `app/composables/useVoiceDictation.ts`) exchange JSON control
 * frames AND binary audio frames; this module covers the JSON frames
 * — binary audio is just `ArrayBuffer`, no contract needed.
 *
 * Why this matters: control frames are the protocol's coordination
 * channel. A drift between sender and receiver (server adds a new
 * `type` value the client doesn't handle, or client sends a field
 * the server doesn't read) doesn't crash — it silently degrades.
 * The user notices "transcripts didn't appear" without any error.
 *
 * Discriminated unions on `type` let consumers narrow exhaustively:
 *
 * ```ts
 * function handle(frame: DictateServerFrame) {
 *   switch (frame.type) {
 *     case 'partial': return showPartial(frame.text)
 *     case 'final':   return commit(frame.text)
 *     // … TS errors if you forget a case
 *   }
 * }
 * ```
 *
 * Adding a new frame type:
 *   1. Add a new union member here.
 *   2. The compiler flags every consumer's switch as non-exhaustive.
 *   3. Land handlers in lockstep.
 *
 * Removing a frame type:
 *   1. Remove the union member.
 *   2. Compiler errors at every sender that still produces it.
 *   3. Land senders in lockstep.
 */

// ─── Server → Client ──────────────────────────────────────────────────

/**
 * Sent immediately on socket open. The 'send your auth now' signal.
 * No payload.
 */
export interface HelloFrame { type: 'hello' }

/**
 * Sent after JWT verification + Cloud STT stream is up. The 'send
 * audio now' signal. No payload.
 */
export interface ReadyFrame { type: 'ready' }

/**
 * Interim transcript. May be revised by future partials or replaced
 * by a final. Render as ghost text (CM6 widget) at the caret.
 */
export interface PartialFrame { type: 'partial', text: string }

/**
 * Finalized phrase. The transcript text is committed into the doc
 * via `ydoc.transact(fn, 'dictation:{userId}')`. Subsequent partials
 * start fresh.
 */
export interface FinalFrame { type: 'final', text: string }

/**
 * Fatal error — the socket will close on the next tick. Surface
 * `message` to the user.
 *
 * Server-side `message` strings are intentionally short ('Missing
 * token', 'Invalid or expired token', 'Token scope mismatch',
 * 'Server misconfigured', 'upstream send failed', etc.). Clients
 * should NOT pattern-match on `message` — it's for human display
 * only.
 */
export interface ErrorFrame { type: 'error', message: string }

/**
 * Daily audio-budget hit. `remaining` is milliseconds left in the
 * current day's window (zero or negative when sent). The session
 * closes after this frame. Client should surface an upgrade CTA.
 *
 * `reason: 'interactions'` distinguishes the case where the per-month
 * INTERACTION budget is exhausted (in which case `remaining` is
 * always 0) from the audio-ms day-budget exhaustion. Both close the
 * socket; both surface the same upgrade CTA. Omitted means the
 * audio-ms day-budget tripped — this is the original / common case.
 */
export interface BudgetExhaustedFrame {
  type: 'budget-exhausted'
  remaining: number
  reason?: 'interactions'
}

/**
 * Per-session 10-minute cap hit. Hard ceiling regardless of daily
 * budget — protects against a user holding the mic open for hours.
 * The session closes after this frame.
 */
export interface SessionCapFrame { type: 'session-cap' }

/**
 * 30-second idle (no audio chunks received). The session closes
 * after this frame. Client should auto-restart on next mic press
 * if the user re-engages quickly.
 */
export interface IdleTimeoutFrame { type: 'idle-timeout' }

export type DictateServerFrame =
  | HelloFrame
  | ReadyFrame
  | PartialFrame
  | FinalFrame
  | ErrorFrame
  | BudgetExhaustedFrame
  | SessionCapFrame
  | IdleTimeoutFrame

/** Literal-union of every server-frame type. Used by tests + log
 *  consumers that need a runtime list (the type-only union isn't
 *  iterable). */
export const DICTATE_SERVER_FRAME_TYPES = [
  'hello',
  'ready',
  'partial',
  'final',
  'error',
  'budget-exhausted',
  'session-cap',
  'idle-timeout'
] as const

// ─── Client → Server ──────────────────────────────────────────────────

/**
 * MUST be the FIRST message on the socket. The server's auth-deadline
 * timer (5s) closes the socket if this doesn't arrive in time.
 *
 * `token` is the dictate JWT minted by `POST /api/ai/dictate/token`
 * (typed against `DictateJwtPayload` in `shared/contracts/jwt.ts`).
 *
 * `languageCode` is an optional BCP-47 tag (`en-US`, `de-DE`, …)
 * OR a short locale (`en`, `de`, …) which the server normalises via
 * `normalizeLanguageCode`. Defaults to `en-US` when omitted or
 * unrecognised.
 */
export interface AuthClientFrame {
  type: 'auth'
  token: string
  languageCode?: string
}

/**
 * Graceful shutdown signal. The server flushes any in-flight Cloud
 * STT response, sends a final `final` frame if appropriate, and
 * closes the socket. Audio chunks that arrive AFTER `stop` are
 * silently dropped (the straggler-chunk guard).
 */
export interface StopClientFrame { type: 'stop' }

export type DictateClientFrame = AuthClientFrame | StopClientFrame

/** Literal-union of every client-frame type. */
export const DICTATE_CLIENT_FRAME_TYPES = ['auth', 'stop'] as const

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Type-safe builder for server frames. Tests and the server handler
 * can use this to construct frames against the contract — a missing
 * field becomes a compile error.
 *
 * The narrowing is the whole point: passing `{ type: 'partial' }`
 * without `text` is a TS error here, but a runtime no-op if you
 * just `JSON.stringify({type:'partial'})` directly.
 */
export function encodeServerFrame(frame: DictateServerFrame): string {
  return JSON.stringify(frame)
}

export function encodeClientFrame(frame: DictateClientFrame): string {
  return JSON.stringify(frame)
}
