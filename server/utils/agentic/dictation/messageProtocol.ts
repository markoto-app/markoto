import * as Sentry from '@sentry/nuxt'
import { releaseSessionLock } from '../../platform/rateLimit'
import type { tryParseControl } from '../dictateHelpers'
import { encodeServerFrame } from '~~/shared/contracts/dictateWs'
import { useLogger } from '../../platform/logger'
import { rejectPeer, resetIdleTimer, type DictatePeerContext, type PeerLike } from './peerContext'
import { handleAuth } from './dictationAuth'
import { startVoiceTickOrchestrator, stopVoiceTickOrchestrator } from './voiceTicks'

const log = useLogger('dictate')

// The frames of a dictation socket after it opened: the `auth` message
// first (anything else refuses the socket), then raw PCM audio chunks
// and the `stop` control frame. And the teardown both close and error
// share.

type ParsedControl = NonNullable<ReturnType<typeof tryParseControl>>

/**
 * Pre-auth branch. Anything non-control (i.e. binary audio) is rejected
 * so a malicious client can't ship audio bytes before auth. The first
 * accepted message must be `{type:'auth'}`.
 */
export async function handlePreAuthMessage(p: PeerLike, ctx: DictatePeerContext, parsedControl: ParsedControl | null): Promise<void> {
  if (!parsedControl) {
    rejectPeer(p, 'Auth required before audio', 4000, 'pre-auth binary')
    return
  }
  if (parsedControl.type !== 'auth') {
    rejectPeer(p, 'First message must be auth', 4000, 'auth first')
    return
  }
  await handleAuth(p, ctx, parsedControl.token, parsedControl.languageCode)
}

/** Coerce a crossws-typed `rawData` (declared `unknown`) to a Buffer. Returns null if the runtime payload matches neither expected shape; the chunk is then dropped. */
function toBuffer(raw: unknown): Buffer | null {
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  return null
}

/** Post-auth control frame handler. Today only `stop` is meaningful; other frames are ignored (forward-compat). */
export function handlePostAuthControl(ctx: DictatePeerContext, parsedControl: ParsedControl): void {
  if (parsedControl.type !== 'stop') return
  ctx.sttEnded = true
  try {
    ctx.stt?.end()
  } catch { /* best-effort */ }
}

/**
 * Forward one binary audio chunk to the upstream STT stream and drive
 * the per-minute billing tick. Drops chunks that arrive after `stop`
 * (the AudioWorklet queue can still hold ~128 ms when the user clicks
 * stop) so stragglers don't surface as "error" frames.
 */
export async function handleAudioChunk(p: PeerLike, ctx: DictatePeerContext, raw: unknown): Promise<void> {
  if (ctx.sttEnded) return
  if (!ctx.stt) return
  const buf = toBuffer(raw)
  if (!buf) return
  try {
    ctx.stt.write(buf)
  } catch (e) {
    log.error('stt write failed', { err: e })
    Sentry.captureException(e, { tags: { component: 'dictate', event: 'stt_write_failed' } })
    p.send(encodeServerFrame({ type: 'error', message: 'upstream send failed' }))
    p.close(1011, 'stt write failed')
    return
  }

  // Done AFTER the write succeeds so a failed chunk doesn't contribute
  // to the bill.
  ctx.voiceAudioSinceTick = true

  // Start the 60s billing heartbeat on the first
  // audio chunk. Idempotent (only the first call arms the interval).
  // BYOK: only when the stream runs on the operator's Mistral key — a
  // user's own key is billed by Mistral directly, not by our budget.
  if (ctx.voiceTickBilling && !ctx.voiceTickActive) {
    startVoiceTickOrchestrator(p, ctx)
  }
  resetIdleTimer(p, ctx)
}

/**
 * The socket is gone (closed or errored): stop billing (with the
 * round-up tick), drop the upstream stream and release the user's
 * one-session lock.
 */
export function releaseDictation(ctx: DictatePeerContext): void {
  stopVoiceTickOrchestrator(ctx)
  try {
    ctx.stt?.destroy()
  } catch {
    /* best-effort */
  }
  if (ctx.userId !== undefined) {
    void releaseSessionLock('ai-dictate-active', String(ctx.userId))
  }
}
