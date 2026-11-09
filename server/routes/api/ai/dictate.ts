import jwt from 'jsonwebtoken'
import * as Sentry from '@sentry/nuxt'
import {
  tryAcquireSessionLock,
  releaseSessionLock
} from '../../../utils/rateLimit'
import { tryParseControl, normalizeLanguageCode } from '../../../utils/agentic/dictateHelpers'
import {
  createDictateRealtimeClient,
  type SpeechStream
} from '../../../utils/agentic/dictateSpeechClient'
import { useLitellmForUser } from '../../../utils/litellmClient'
import { liveDictationTarget, resolveAiProviders, type LiveDictationTarget } from '../../../utils/aiProviders/resolve'
import { resolveBillingContext } from '../../../utils/billing'
import { isBudgetExceededError } from '../../../utils/litellmKeys'
import { FEATURE_TAGS, featureMetadata } from '../../../utils/litellm/featureTags'
import { litellmCompletion } from '../../../utils/litellm/createCompletion'
import { getDoc } from '../../../repos/documents'
import type { DictateJwtPayload } from '~~/shared/contracts/jwt'
import { encodeServerFrame } from '~~/shared/contracts/dictateWs'

// WebSocket relay for live voice dictation. Bridges the browser's PCM
// audio stream to Mistral Voxtral Realtime via the official
// `@mistralai/mistralai/extra/realtime` SDK and forwards transcript
// events back to the client.
//
// Why Voxtral Realtime (post-Phase-5): purpose-built streaming
// transcription with true interim-result streaming the moment a
// phoneme is confident, and `is_final: true` when the recognizer
// commits. The SDK opens a direct WS to Mistral (NOT through LiteLLM
// — LiteLLM doesn't proxy stateful WS streams); LiteLLM still sees the
// per-minute billing tick (`voxtral-realtime-tick`) so spend lands on
// the right per-user virtual key. Pre-Phase-5 (Gemini-era) this path
// ran against Google Cloud Speech-to-Text v1; some helper names
// (`stt`, `SpeechStream`) survive from that era.
//
// Wire format:
//   Client → server (JSON, before auth):
//     - `{ type: 'auth', token, languageCode? }` — FIRST message after
//       open. Must arrive within `AUTH_DEADLINE_MS` or we close. Token
//       is the short-lived JWT from POST /api/ai/dictate/token.
//       Passing the token in the first WS MESSAGE (not `?token=` in the
//       URL) avoids leaking it into access logs, referer headers, and
//       browser history — the URL never carries a credential.
//   Client → server (after auth):
//     - binary frames: raw int16 PCM chunks from the AudioWorklet
//       (2048 samples @ 16 kHz = 128 ms per chunk).
//     - `{ type: 'stop' }` JSON: graceful shutdown; caller finalizes.
//   Server → client (JSON, always):
//     - `{ type: 'hello' }` immediately on open — "send auth now"
//     - `{ type: 'ready' }` after auth + STT stream up — "send audio now"
//     - `{ type: 'partial', text }` interim transcripts
//     - `{ type: 'final', text }` finalized phrases
//     - `{ type: 'error', message }` fatal; socket closes next
//     - `{ type: 'budget-exhausted', remaining }` daily cap hit
//     - `{ type: 'session-cap' }` per-session 10 min cap
//     - `{ type: 'idle-timeout' }` 30 s without audio
//
// Rate-limit: audio-ms (NOT requests). Each 2048-sample chunk @ 16 kHz
// = 128 ms of audio; we debit that into a per-user daily budget whose
// size depends on the caller's tier (Free=5min, Pro=30min, Max/Ultra=60min).
// The daily cap backstops the interaction counter — a user can't bypass
// the monthly interaction budget by dictating continuously for a month.

const SESSION_HARD_CAP_MS = 10 * 60 * 1000
const IDLE_TIMEOUT_MS = 30_000
// Deadline for the client's first `auth` message. Long enough to cover
// a slow first paint but short enough that an unauthenticated socket
// can't sit open consuming resources indefinitely.
const AUTH_DEADLINE_MS = 5_000

// Concurrent-session cap is enforced via a Valkey lock (see
// `tryAcquireSessionLock`) rather than an in-memory Set. An in-memory
// Set would only catch same-process conflicts, so two tabs landing on
// different Nitro workers / containers would both slip through. The
// Valkey lock's TTL is set to `SESSION_HARD_CAP_MS` below so a
// crashed process self-heals its lock.

// Minimal surface of the realtime streaming transcription API we
// actually use. Defined in dictateSpeechClient.ts so the real Voxtral
// Realtime client and the test-mode mock satisfy the same contract —
// imported here as SttStream (alias) for backwards compat with the
// names in this file (legacy from the Cloud STT era).
type SttStream = SpeechStream

interface DictatePeerContext {
  userId?: number
  docId?: string
  /** Workspace this doc belongs to, if any — drives the workspace-axis
   *  spend tag on voice-tick LiteLLM calls. Resolved at auth time. */
  workspaceId?: string | null
  /** User's virtual-key bearer token, resolved at auth time. */
  virtualKey?: string
  /**
   * Phase 5 voice-tick orchestrator state. Each tick fires a fake chat
   * completion against the `voxtral-realtime-tick` LiteLLM model →
   * $0.006 billed per tick = 1 minute of Voxtral Realtime audio.
   * Real transcription stays on the direct WS to Mistral; the tick
   * exists only so spend lands in the same per-key budget as everything
   * else (LiteLLM is the only gate post-Phase-6). Round-up policy: on
   * close, fire ONE final tick if any audio flowed in the partial
   * minute since the last tick. Documented overrun: ≤1 extra minute.
   */
  /** True when the stream runs on the operator's Mistral key (platform-paid) → bill ticks. */
  voiceTickBilling?: boolean
  voiceTickInterval?: ReturnType<typeof setInterval>
  voiceTickActive?: boolean
  voiceLastTickAt?: number // ms epoch of the last tick fired
  voiceAudioSinceTick?: boolean // any audio since last tick? drives round-up
  // Phase 6: dropped per-tier daily audio budget + accumulated-audio-ms
  // ledger. The voice-tick orchestrator (voxtral path) bills against
  // the user's LiteLLM virtual key once per minute; LiteLLM enforces
  // the $ cap. Single-session lock + idle timeout + session hard-cap
  // remain as orthogonal safety/UX guards.
  /**
   * Voxtral Realtime stream. Populated in `handleAuth` after the JWT
   * checks out; every code path that reaches for it also checks
   * `authed`. (Field name `stt` survives from the pre-Phase-5
   * Cloud STT era.)
   */
  stt?: SttStream
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

interface PeerLike {
  send: (data: string) => unknown
  close: (code?: number, reason?: string) => void
  context: Record<string, unknown>
}

export default defineEventHandler({
  handler() {
    throw createError({ statusCode: 426, message: 'Upgrade Required: WebSocket only' })
  },

  websocket: {
    // The upgrade hook no longer authenticates — auth moved to the
    // first WS message so the JWT never appears in the URL. crossws's
    // upgrade hook would otherwise give us a raw Request with no
    // Authorization header support, forcing us to either reject every
    // WS (no auth yet) or accept every WS (unsafe). The auth-on-first-
    // message pattern keeps the token off the URL while still closing
    // the socket in 5s if nothing valid arrives.
    upgrade() {
      // Intentionally empty — every connection is allowed to OPEN.
      // Authentication + user binding happen in the `message` hook
      // below; the `open` hook arms a deadline that closes the socket
      // if no valid auth arrives in time.
    },

    open(peer) {
      const p = peer as unknown as PeerLike
      const ctx = p.context as DictatePeerContext
      p.send(encodeServerFrame({ type: 'hello' }))
      ctx.authTimer = setTimeout(() => {
        if (!ctx.authed) {
          p.send(encodeServerFrame({ type: 'error', message: 'Auth timeout' }))
          p.close(4000, 'auth timeout')
        }
      }, AUTH_DEADLINE_MS)
    },

    async message(peer, message) {
      const p = peer as unknown as PeerLike
      const ctx = p.context as DictatePeerContext
      if (ctx.closed) return

      // Text-vs-binary detection is tricky with crossws over the Node
      // `ws` library: text frames arrive as Buffer too, so `typeof
      // rawData === 'string'` is not reliable. We distinguish by
      // trying to parse the frame as JSON via `message.text()` — a
      // valid JSON object with a known `type` is a control frame;
      // anything else is treated as binary audio. This is safe because
      // our audio path is raw int16 PCM (never valid JSON).
      const parsedControl = tryParseControl(message)

      if (!ctx.authed) {
        await handlePreAuthMessage(p, ctx, parsedControl)
        return
      }

      // Post-auth branch. Control frames (`{type:'stop'}`) and audio
      // (raw binary) both land here; the type-parse above routes us.
      if (parsedControl) {
        handlePostAuthControl(ctx, parsedControl)
        return
      }
      await handleAudioChunk(p, ctx, message.rawData)
    },

    close(peer) {
      const ctx = (peer as unknown as PeerLike).context as DictatePeerContext
      ctx.closed = true
      if (ctx.authTimer) clearTimeout(ctx.authTimer)
      if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
      if (ctx.hardCapTimer) clearTimeout(ctx.hardCapTimer)
      stopVoiceTickOrchestrator(ctx)
      try {
        ctx.stt?.destroy()
      } catch {
        /* best-effort */
      }
      if (ctx.userId !== undefined) {
        void releaseSessionLock('ai-dictate-active', String(ctx.userId))
      }
    },

    error(peer, err) {
      console.error('[dictate] ws error:', err)
      Sentry.captureException(err, {
        tags: { component: 'dictate', event: 'ws_error' }
      })
      const ctx = (peer as unknown as PeerLike).context as DictatePeerContext
      ctx.closed = true
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
  }
})

// ─── Per-message routing helpers ───────────────────────────────────────

type ParsedControl = NonNullable<ReturnType<typeof tryParseControl>>

/**
 * Pre-auth branch. Anything non-control (i.e. binary audio) is rejected
 * so a malicious client can't ship audio bytes before auth. The first
 * accepted message must be `{type:'auth'}`.
 */
async function handlePreAuthMessage(p: PeerLike, ctx: DictatePeerContext, parsedControl: ParsedControl | null): Promise<void> {
  if (!parsedControl) {
    p.send(encodeServerFrame({ type: 'error', message: 'Auth required before audio' }))
    p.close(4000, 'pre-auth binary')
    return
  }
  if (parsedControl.type !== 'auth') {
    p.send(encodeServerFrame({ type: 'error', message: 'First message must be auth' }))
    p.close(4000, 'auth first')
    return
  }
  await handleAuth(p, ctx, parsedControl.token, parsedControl.languageCode)
}

/** Coerce a crossws-typed `rawData` (declared `unknown`) to a Buffer. Returns null if the runtime payload doesn't match either expected shape — chunk silently dropped, same effect as the pre-refactor `Buffer.from(raw as Uint8Array)` on a hypothetical mismatch. */
function toBuffer(raw: unknown): Buffer | null {
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  return null
}

/** Post-auth control frame handler. Today only `stop` is meaningful; other frames are ignored (forward-compat). */
function handlePostAuthControl(ctx: DictatePeerContext, parsedControl: ParsedControl): void {
  if (parsedControl.type !== 'stop') return
  ctx.sttEnded = true
  try {
    ctx.stt?.end()
  } catch { /* best-effort */ }
}

/**
 * Forward one binary audio chunk to the upstream STT stream and drive
 * the per-minute billing tick. Drops chunks that arrive after `stop`
 * (the browser's AudioWorklet → main-thread postMessage queue can be
 * up to ~128 ms in-flight when the user clicks stop), so each
 * straggler doesn't surface as an "error" frame on the wire.
 *
 * Phase 6: dropped the daily-audio-ms cap. The voice-tick orchestrator
 * (voxtral path) bills against the user's LiteLLM virtual key once
 * per minute; LiteLLM enforces the $ cap. The single-session Valkey
 * lock + idle timeout + session hard-cap remain as orthogonal
 * safety/UX guards.
 */
async function handleAudioChunk(p: PeerLike, ctx: DictatePeerContext, raw: unknown): Promise<void> {
  if (ctx.sttEnded) return
  if (!ctx.stt) return
  const buf = toBuffer(raw)
  if (!buf) return
  try {
    ctx.stt.write(buf)
  } catch (e) {
    console.error('[dictate] stt write failed:', e)
    Sentry.captureException(e, { tags: { component: 'dictate', event: 'stt_write_failed' } })
    p.send(encodeServerFrame({ type: 'error', message: 'upstream send failed' }))
    p.close(1011, 'stt write failed')
    return
  }

  // Done AFTER the write succeeds so a failed chunk doesn't contribute
  // to the bill.
  ctx.voiceAudioSinceTick = true

  // Phase 5 voice-tick: start the 60s billing heartbeat on the first
  // audio chunk. Idempotent (only the first call arms the interval).
  // BYOK: only when the stream runs on the operator's Mistral key — a
  // user's own key is billed by Mistral directly, not by our budget.
  if (ctx.voiceTickBilling && !ctx.voiceTickActive) {
    startVoiceTickOrchestrator(p, ctx)
  }
  resetIdleTimer(p, ctx)
}

// ─── Phase 5 voice-tick orchestrator ───────────────────────────────────
//
// Bills $0.006 per minute of Voxtral Realtime audio against the user's
// LiteLLM budget. Implementation:
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
//
// Phase 6 will swap the master-key tick for a per-user virtual key.

const VOICE_TICK_INTERVAL_MS = 60_000

function startVoiceTickOrchestrator(peer: PeerLike, ctx: DictatePeerContext): void {
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

function stopVoiceTickOrchestrator(ctx: DictatePeerContext): void {
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

async function fireVoiceTick(peer: PeerLike, ctx: DictatePeerContext): Promise<void> {
  if (!ctx.virtualKey) return
  try {
    const litellm = useLitellmForUser(ctx.virtualKey)
    const config = useRuntimeConfig()
    const model = config.litellm?.realtimeTickModel || 'voxtral-realtime-tick'
    await litellmCompletion(litellm, {
      model,
      messages: [{ role: 'user', content: 'tick' }],
      ...featureMetadata(FEATURE_TAGS.dictateTick, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        docId: ctx.docId
      })
    })
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
    console.warn(`[dictate] voice-tick failed (continuing): ${e instanceof Error ? e.message : e}`)
  }
}

async function fireRoundUpTick(ctx: DictatePeerContext): Promise<void> {
  if (!ctx.virtualKey) return
  try {
    const litellm = useLitellmForUser(ctx.virtualKey)
    const config = useRuntimeConfig()
    const model = config.litellm?.realtimeTickModel || 'voxtral-realtime-tick'
    await litellmCompletion(litellm, {
      model,
      messages: [{ role: 'user', content: 'round-up' }],
      ...featureMetadata(FEATURE_TAGS.dictateTick, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        docId: ctx.docId
      })
    })
  } catch (e) {
    // Fire-and-forget — by the time we round-up the WS is gone and
    // there's no one to surface the error to. Telemetry would just be
    // noise.
    console.warn(`[dictate] round-up tick failed: ${e instanceof Error ? e.message : e}`)
  }
}

async function handleAuth(
  peer: PeerLike,
  ctx: DictatePeerContext,
  token: unknown,
  languageCode: unknown
) {
  const config = useRuntimeConfig()
  const secret = config.aiDictateJwtSecret || config.jwtSecret
  if (!secret) {
    peer.send(encodeServerFrame({ type: 'error', message: 'Server misconfigured' }))
    peer.close(1011, 'no jwt secret')
    return
  }
  if (typeof token !== 'string' || !token) {
    peer.send(encodeServerFrame({ type: 'error', message: 'Missing token' }))
    peer.close(4001, 'missing token')
    return
  }
  // Type as Partial<DictateJwtPayload> — the verifier can't trust any
  // field is present until it's narrowed below. Using the shared
  // contract here pins the verify-shape to the mint-shape; a drift
  // (e.g. mint forgetting `scope`) becomes a compile error rather
  // than a runtime test failure with a misleading close-code.
  let payload: Partial<DictateJwtPayload>
  try {
    payload = jwt.verify(token, secret) as Partial<DictateJwtPayload>
  } catch {
    peer.send(encodeServerFrame({ type: 'error', message: 'Invalid or expired token' }))
    peer.close(4001, 'invalid token')
    return
  }
  if (payload.kind !== 'dictate' || typeof payload.userId !== 'number' || typeof payload.docId !== 'string') {
    peer.send(encodeServerFrame({ type: 'error', message: 'Malformed token' }))
    peer.close(4001, 'malformed payload')
    return
  }
  // Require explicit `scope: 'dictate'`. Pairs with the
  // sync-server's "any non-empty scope is rejected for WS auth" rule
  // (sync-server/src/auth.ts) — together they ensure dictate tokens
  // are usable HERE and only here. A token minted for any other
  // scope (`render`, `file-access`, future) cannot be replayed
  // against this WS, and a dictate token cannot be replayed against
  // Hocuspocus.
  if (payload.scope !== 'dictate') {
    peer.send(encodeServerFrame({ type: 'error', message: 'Token scope mismatch' }))
    peer.close(4001, 'scope mismatch')
    return
  }

  // Concurrent-session cap: one dictation session per user. Prevents a
  // user with multiple tabs open from silently burning their daily
  // budget 2-3× faster than expected (each chunk debits the shared
  // bucket, so concurrency amplifies spend without any UX signal).
  // TTL matches the session hard cap so a crashed worker's lock
  // self-expires.
  const lockAcquired = await tryAcquireSessionLock(
    'ai-dictate-active',
    String(payload.userId),
    SESSION_HARD_CAP_MS
  )
  if (!lockAcquired) {
    peer.send(encodeServerFrame({ type: 'error', message: 'Another dictation session is already active' }))
    peer.close(4001, 'session already active')
    return
  }

  ctx.userId = payload.userId
  ctx.docId = payload.docId
  ctx.authed = true
  if (ctx.authTimer) {
    clearTimeout(ctx.authTimer)
    ctx.authTimer = undefined
  }

  // Phase 6: resolve billing context to get the user's virtual-key
  // token. If resolution fails (DB blip, missing user row) close the
  // session rather than silently fall through — billing is a
  // correctness surface, not a rate limit. The voice-tick orchestrator
  // hits LiteLLM with this key; if the user's $ budget is already 0,
  // the FIRST tick (fired on first audio chunk) returns 4xx and the
  // WS closes cleanly with `budget_exhausted` code 1011.
  // Resolve the doc's workspace first: it tags the spend AND decides
  // which plan pays (a Team / Business workspace's member key, WP3/WP5). Best-effort — a doc that
  // disappeared mid-handshake just means we tag with no workspace
  // dimension, which is harmless (the call still bills correctly).
  try {
    const doc = await getDoc(payload.docId)
    ctx.workspaceId = doc?.workspaceId ?? null
  } catch {
    ctx.workspaceId = null
  }

  let billing: Awaited<ReturnType<typeof resolveBillingContext>>
  try {
    billing = await resolveBillingContext(payload.userId, ctx.workspaceId)
  } catch (e) {
    console.error('[dictate] billing resolve failed:', e)
    Sentry.captureException(e, {
      tags: { component: 'dictate', event: 'billing_resolve_failed', userId: String(payload.userId) }
    })
    peer.send(encodeServerFrame({ type: 'error', message: 'Could not resolve billing; please retry.' }))
    peer.close(1011, 'billing resolve failed')
    return
  }
  // BYOK: live dictation is Voxtral Realtime (Mistral-only, direct WS).
  // Available with the user's own Mistral transcription key (their
  // account pays — no LiteLLM ticks) or with a platform-alias instance
  // default + the operator's MISTRAL_API_KEY (ticks bill the user's
  // LiteLLM budget, as before BYOK). The mic is hidden otherwise; this
  // is the server-side backstop.
  let target: LiveDictationTarget | null
  try {
    target = liveDictationTarget((await resolveAiProviders(payload.userId, billing.plan)).transcription)
  } catch (e) {
    console.error('[dictate] provider resolve failed:', e instanceof Error ? e.message : e)
    target = null
  }
  if (!target) {
    peer.send(encodeServerFrame({ type: 'error', message: 'Live dictation needs a Mistral transcription key. Add one in Settings → AI provider.' }))
    peer.close(4004, 'no dictation provider')
    return
  }
  ctx.virtualKey = billing.virtualKey
  ctx.voiceTickBilling = target.platformBilled

  const client = createDictateRealtimeClient(target.apiKey, target.model, target.serverURL)

  // Normalize language: accept either BCP-47 (`de-DE`) or the short
  // ISO 639-1 UI locale (`de`). Defaults to en-US if nothing usable
  // arrived — the upstream transcription API requires a valid
  // language code or rejects.
  const lang = normalizeLanguageCode(languageCode)

  let sttStream: SttStream
  try {
    sttStream = client.streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: lang,
        enableAutomaticPunctuation: true,
        model: 'latest_long'
      },
      interimResults: true
    })
  } catch (e) {
    console.error('[dictate] streamingRecognize init failed:', e)
    Sentry.captureException(e, {
      tags: { component: 'dictate', event: 'stt_init_failed' }
    })
    peer.send(encodeServerFrame({ type: 'error', message: 'Could not start transcription session' }))
    peer.close(1011, 'stt init failed')
    return
  }

  sttStream.on('data', (raw) => {
    const data = raw as {
      results?: Array<{
        alternatives?: Array<{ transcript?: string }>
        isFinal?: boolean
      }>
    }
    const r = data.results?.[0]
    const text = r?.alternatives?.[0]?.transcript
    if (!text) return
    peer.send(encodeServerFrame({ type: r?.isFinal ? 'final' : 'partial', text }))
  })

  sttStream.on('error', (err) => {
    const msg = (err as { message?: string })?.message ?? 'transcription error'
    // "write after end" is expected if the client fired stop and a
    // stray audio chunk slipped past the `sttEnded` guard. Drop it
    // silently — surfacing it as a UI error on the client would show
    // a toast for what was really a clean shutdown.
    if (ctx.sttEnded && /write after end/i.test(msg)) return
    console.error('[dictate] stt error:', err)
    Sentry.captureException(err, {
      tags: { component: 'dictate', event: 'stt_stream_error' }
    })
    if (!ctx.closed) {
      peer.send(encodeServerFrame({ type: 'error', message: msg }))
      peer.close(1011, 'stt error')
    }
  })
  sttStream.on('end', () => {
    if (!ctx.closed) peer.close(1000, 'stt ended')
  })

  ctx.stt = sttStream
  peer.send(encodeServerFrame({ type: 'ready' }))

  ctx.hardCapTimer = setTimeout(() => {
    peer.send(encodeServerFrame({ type: 'session-cap' }))
    peer.close(4003, 'session cap')
  }, SESSION_HARD_CAP_MS)
  resetIdleTimer(peer, ctx)
}

function resetIdleTimer(peer: PeerLike, ctx: DictatePeerContext) {
  if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
  ctx.idleTimer = setTimeout(() => {
    peer.send(encodeServerFrame({ type: 'idle-timeout' }))
    peer.close(4001, 'idle timeout')
  }, IDLE_TIMEOUT_MS)
}

/**
 * Charge interactions for accumulated dictation audio on WS close.
 * Runs via `void` — we don't want to block the close hook on a DB
 * round-trip. Errors are logged but not propagated: a dead DB
 * shouldn't prevent the WS from tearing down cleanly.
 */
