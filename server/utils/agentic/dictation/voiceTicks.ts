import { useLitellmForUser } from '../../ai/litellmClient'
import { isBudgetExceededError } from '../../litellm/userKeys'
import { FEATURE_TAGS, featureMetadata } from '../../litellm/featureTags'
import { litellmCompletion } from '../../litellm/createCompletion'
import { encodeServerFrame } from '~~/shared/contracts/dictateWs'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../../platform/logger'
import type { DictatePeerContext, PeerLike } from './peerContext'

const log = useLogger('dictate')

// Voice-tick orchestrator: bills $0.006 per minute of Voxtral Realtime
// audio against the user's LiteLLM budget by firing a fake chat
// completion on the `voxtral-realtime-tick` model (the real transcription
// runs on the direct WS to Mistral).
//   - Started on the first audio chunk (not on auth) so a connection
//     that opens but never sends audio doesn't get billed.
//   - 60s `setInterval` fires `voxtral-realtime-tick` chat completion;
//     LiteLLM's spend logger bills the calling key for $0.006.
//   - On `budget_exceeded` (HTTP 400 from LiteLLM) → close WS with
//     code 1011 reason `budget_exhausted`. Frontend already handles
//     WS close with a generic "session ended" toast.
//   - On transient failure (network blip, LiteLLM timeout) → silently
//     continue; the next tick will retry. A genuinely-down proxy
//     means the next tick also fails, the WS stays open, and the
//     user keeps dictating "for free" until close — accepted small
//     overrun under degraded infra.
//   - Round-up: on close, fire ONE final tick if any audio flowed in
//     the partial minute since the last tick. Documented overrun:
//     ≤1 extra minute charged per session.

const VOICE_TICK_INTERVAL_MS = 60_000

export function startVoiceTickOrchestrator(peer: PeerLike, ctx: DictatePeerContext): void {
  if (ctx.voiceTickActive) return
  ctx.voiceTickActive = true
  ctx.voiceLastTickAt = Date.now()
  ctx.voiceAudioSinceTick = false

  // Fire the first tick immediately so the first minute of audio is
  // charged up-front (not retroactively when the next tick fires).
  void fireVoiceTick(peer, ctx)

  ctx.voiceTickInterval = setInterval(() => {
    if (ctx.closed || !ctx.voiceTickActive) {
      stopVoiceTickOrchestrator(ctx)
      return
    }
    void fireVoiceTick(peer, ctx)
  }, VOICE_TICK_INTERVAL_MS)
}

export function stopVoiceTickOrchestrator(ctx: DictatePeerContext): void {
  if (ctx.voiceTickInterval) {
    clearInterval(ctx.voiceTickInterval)
    ctx.voiceTickInterval = undefined
  }
  if (!ctx.voiceTickActive) return
  ctx.voiceTickActive = false
  // Round-up: if any audio flowed since the last tick, fire one final
  // tick. Fire-and-forget because the WS is closing anyway — we can't
  // signal failures back to the user at this point.
  if (ctx.voiceAudioSinceTick) {
    ctx.voiceAudioSinceTick = false
    void fireRoundUpTick(ctx)
  }
}

/** One billing call on the tick model, authenticated with the user's virtual key and spend-tagged. */
async function postTick(ctx: DictatePeerContext & { virtualKey: string }, content: 'tick' | 'round-up'): Promise<void> {
  const litellm = useLitellmForUser(ctx.virtualKey)
  const env = useEnv()
  const model = env.litellm.realtimeTickModel || 'voxtral-realtime-tick'
  await litellmCompletion(litellm, {
    model,
    messages: [{ role: 'user', content }],
    ...featureMetadata(FEATURE_TAGS.dictateTick, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      docId: ctx.docId
    })
  })
}

function hasVirtualKey(ctx: DictatePeerContext): ctx is DictatePeerContext & { virtualKey: string } {
  return Boolean(ctx.virtualKey)
}

async function fireVoiceTick(peer: PeerLike, ctx: DictatePeerContext): Promise<void> {
  if (!hasVirtualKey(ctx)) return
  try {
    await postTick(ctx, 'tick')
    ctx.voiceLastTickAt = Date.now()
    ctx.voiceAudioSinceTick = false
  } catch (e) {
    if (isBudgetExceededError(e)) {
      // Hard exhaustion → close the WS so the user gets the standard
      // close-event flow (frontend already handles WS close with a
      // toast). Keep the message short — code:1011 is "internal error"
      // in WS spec, the most appropriate close code for "we ended your
      // session for an internal reason".
      try {
        peer.send(encodeServerFrame({ type: 'budget-exhausted', remaining: 0 }))
      } catch { /* peer may already be gone */ }
      try {
        peer.close(1011, 'budget_exhausted')
      } catch { /* peer may already be closing */ }
      ctx.closed = true
      return
    }
    // Transient failure (network, LiteLLM hiccup) — log + continue.
    // The next tick (60s later) will retry.
    log.warn('voice-tick failed (continuing)', { err: e })
  }
}

async function fireRoundUpTick(ctx: DictatePeerContext): Promise<void> {
  if (!hasVirtualKey(ctx)) return
  try {
    await postTick(ctx, 'round-up')
  } catch (e) {
    // Fire-and-forget — by the time we round-up the WS is gone and
    // there's no one to surface the error to. Telemetry would just be
    // noise.
    log.warn('round-up tick failed', { err: e })
  }
}
