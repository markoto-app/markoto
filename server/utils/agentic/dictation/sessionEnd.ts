import { encodeServerFrame } from '~~/shared/contracts/dictateWs'
import { SESSION_HARD_CAP_MS, type DictatePeerContext, type PeerLike } from './peerContext'
import { stopVoiceTickOrchestrator } from './voiceTicks'

// How a dictation session ends in an orderly way: no more audio is taken,
// the upstream flushes what it still has, the trailing `final` goes out,
// then `done`, then the close. The client keeps the words it shows on
// screen until `done`, so every path that ends a session while the user
// may still see interim text goes through here (stop, idle timeout,
// session cap).

const IDLE_TIMEOUT_MS = 30_000

/**
 * How long the upstream gets to deliver its trailing transcript after the
 * audio ended. The real service answered 0.3 s after the end of a short
 * clip; four seconds covers a slow answer and stays under the client's own
 * wait (`FINISH_TIMEOUT_MS`), so the client normally hears `done` from here
 * and not from its fallback.
 */
export const END_FLUSH_DEADLINE_MS = 4_000

interface CloseWith { code: number, reason: string }

/**
 * Stop taking audio and let the upstream finish. Billing stops here, not
 * at the close: the wait for the trailing transcript carries no audio.
 */
export function beginSessionEnd(peer: PeerLike, ctx: DictatePeerContext, closeWith: CloseWith = { code: 1000, reason: 'stt ended' }): void {
  if (ctx.sttEnded || ctx.closed) return
  ctx.sttEnded = true
  ctx.closeWith = closeWith
  stopVoiceTickOrchestrator(ctx)
  if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
  if (ctx.hardCapTimer) clearTimeout(ctx.hardCapTimer)

  if (!ctx.stt) {
    completeSession(peer, ctx)
    return
  }
  ctx.flushTimer = setTimeout(() => completeSession(peer, ctx), END_FLUSH_DEADLINE_MS)
  try {
    ctx.stt.end()
  } catch {
    completeSession(peer, ctx)
  }
}

/** Everything was sent (or the upstream took too long): say `done` and close. */
export function completeSession(peer: PeerLike, ctx: DictatePeerContext): void {
  if (ctx.flushTimer) clearTimeout(ctx.flushTimer)
  ctx.flushTimer = undefined
  if (ctx.closed || ctx.completed) return
  ctx.completed = true
  const { code, reason } = ctx.closeWith ?? { code: 1000, reason: 'stt ended' }
  try {
    peer.send(encodeServerFrame({ type: 'done' }))
  } catch { /* peer may already be gone */ }
  peer.close(code, reason)
}

export function resetIdleTimer(peer: PeerLike, ctx: DictatePeerContext): void {
  if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
  ctx.idleTimer = setTimeout(() => {
    peer.send(encodeServerFrame({ type: 'idle-timeout' }))
    beginSessionEnd(peer, ctx, { code: 4001, reason: 'idle timeout' })
  }, IDLE_TIMEOUT_MS)
}

/** After auth: end the session at the hard cap regardless of activity. */
export function armHardCap(peer: PeerLike, ctx: DictatePeerContext): void {
  ctx.hardCapTimer = setTimeout(() => {
    peer.send(encodeServerFrame({ type: 'session-cap' }))
    beginSessionEnd(peer, ctx, { code: 4003, reason: 'session cap' })
  }, SESSION_HARD_CAP_MS)
}
