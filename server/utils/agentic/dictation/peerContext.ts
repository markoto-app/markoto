import type { SpeechStream } from '../dictateSpeechClient'
import { encodeServerFrame } from '~~/shared/contracts/dictateWs'
import { MINUTE_MS } from '~~/shared/config/units'

// The state of one live-dictation WebSocket connection and the timers that
// end it. The route (`server/routes/api/ai/dictate.ts`) owns the hooks; the
// modules in this folder share this state.

export const SESSION_HARD_CAP_MS = 10 * MINUTE_MS
const IDLE_TIMEOUT_MS = 30_000
// Deadline for the client's first `auth` message. Long enough to cover
// a slow first paint but short enough that an unauthenticated socket
// can't sit open consuming resources indefinitely.
export const AUTH_DEADLINE_MS = 5_000

/** Per-connection state, kept on the crossws peer's `context` under `dictate`. */
export class DictatePeerContext {
  userId?: number
  docId?: string
  /** Workspace this doc belongs to, if any; tags spend on voice-tick calls. */
  workspaceId?: string | null
  /** User's virtual-key bearer token, resolved at auth time. */
  virtualKey?: string
  // Voice-tick orchestrator state (see `voiceTicks.ts`).
  /** True when the stream runs on the operator's Mistral key (platform-paid) → bill ticks. */
  voiceTickBilling?: boolean
  voiceTickInterval?: ReturnType<typeof setInterval>
  voiceTickActive?: boolean
  voiceLastTickAt?: number // ms epoch of the last tick fired
  voiceAudioSinceTick?: boolean // any audio since last tick? drives round-up
  /** Voxtral Realtime stream, set in `handleAuth` once the JWT checks out; users also check `authed`. */
  stt?: SpeechStream
  authed?: boolean
  closed?: boolean
  /**
   * Flipped to `true` once the client sends `{type:'stop'}` or we
   * otherwise call `stt.end()`. Guards the audio-write path: any
   * chunks the worklet had queued in postMessage but hadn't yet sent
   * when the client fired stop will arrive here post-end and would
   * otherwise error with "write after end" — we drop them silently.
   */
  sttEnded?: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  hardCapTimer?: ReturnType<typeof setTimeout>
  authTimer?: ReturnType<typeof setTimeout>
}

export interface PeerLike {
  send: (data: string) => unknown
  close: (code?: number, reason?: string) => void
  context: Record<string, unknown>
}

/** The connection's state, created on first use. */
export function dictateContext(peer: PeerLike): DictatePeerContext {
  const existing = peer.context.dictate
  if (existing instanceof DictatePeerContext) return existing
  const created = new DictatePeerContext()
  peer.context.dictate = created
  return created
}

/** Send a fatal `error` frame, then close with `code` / `reason`. */
export function rejectPeer(peer: PeerLike, message: string, code: number, reason: string): void {
  peer.send(encodeServerFrame({ type: 'error', message }))
  peer.close(code, reason)
}

export function resetIdleTimer(peer: PeerLike, ctx: DictatePeerContext): void {
  if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
  ctx.idleTimer = setTimeout(() => {
    peer.send(encodeServerFrame({ type: 'idle-timeout' }))
    peer.close(4001, 'idle timeout')
  }, IDLE_TIMEOUT_MS)
}

/** After auth: end the session at the hard cap regardless of activity. */
export function armHardCap(peer: PeerLike, ctx: DictatePeerContext): void {
  ctx.hardCapTimer = setTimeout(() => {
    peer.send(encodeServerFrame({ type: 'session-cap' }))
    peer.close(4003, 'session cap')
  }, SESSION_HARD_CAP_MS)
}
