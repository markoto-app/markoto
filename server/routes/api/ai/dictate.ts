import jwt from 'jsonwebtoken'
import * as Sentry from '@sentry/nuxt'
import {
  consumeRateLimitBudget,
  tryAcquireSessionLock,
  releaseSessionLock
} from '../../../utils/rateLimit'
import { tryParseControl, normalizeLanguageCode } from '../../../utils/agentic/dictateHelpers'
import { createDictateSpeechClient, type SpeechStream } from '../../../utils/agentic/dictateSpeechClient'
import {
  resolveBillingContext,
  chargeInteractions,
  interactionsForAudioMs,
  BudgetExhausted
} from '../../../utils/billing'
import { TIERS } from '~~/shared/config/tiers'
import type { DictateJwtPayload } from '~~/shared/contracts/jwt'
import { encodeServerFrame } from '~~/shared/contracts/dictateWs'

// WebSocket relay for live voice dictation. Bridges the browser's PCM
// audio stream to Google Cloud Speech-to-Text v1 `streamingRecognize`
// and forwards transcript events back to the client.
//
// Why Cloud STT (not Gemini Live): Gemini Live is a CONVERSATIONAL
// duplex model — its server-side VAD buffers audio until end-of-turn
// and emits transcripts in a burst, so "I spoke 30 s without a pause"
// showed nothing on screen until I stopped. Cloud STT is purpose-built
// for dictation: true interim-result streaming the moment a phoneme
// is confident, and `is_final: true` when the recognizer commits.
// Also ~5× cheaper per minute.
//
// Why v1 (not v2): v2's `streamingRecognize` requires a project id in
// the recognizer resource path (`projects/{project}/locations/...`).
// API-key auth gives us the project implicitly, so v1 — which doesn't
// need the path — keeps the server code to a minimum. `chirp_2` is
// v2-only, but `latest_long` in v1 is more than good enough for
// dictation.
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

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000
const SESSION_HARD_CAP_MS = 10 * 60 * 1000
const IDLE_TIMEOUT_MS = 30_000
// Deadline for the client's first `auth` message. Long enough to cover
// a slow first paint but short enough that an unauthenticated socket
// can't sit open consuming resources indefinitely.
const AUTH_DEADLINE_MS = 5_000
const CHUNK_AUDIO_MS = Math.round((2048 / 16000) * 1000) // 128 ms per chunk

// Concurrent-session cap is enforced via a Valkey lock (see
// `tryAcquireSessionLock`) rather than an in-memory Set. An in-memory
// Set would only catch same-process conflicts, so two tabs landing on
// different Nitro workers / containers would both slip through. The
// Valkey lock's TTL is set to `SESSION_HARD_CAP_MS` below so a
// crashed process self-heals its lock.

// Minimal surface of the Cloud STT streaming API we actually use.
// Defined in dictateSpeechClient.ts so the real SpeechClient and the
// test-mode mock satisfy the same contract — imported here as SttStream
// (alias) for backwards compat with the names in this file.
type SttStream = SpeechStream

interface DictatePeerContext {
  userId?: number
  docId?: string
  /**
   * Per-tier daily audio-ms budget, resolved at auth and pinned for
   * the lifetime of the connection. We don't re-read the user's plan
   * per chunk — a mid-session plan lapse keeps the current session on
   * whatever cap was in effect at auth; the NEXT session starts with
   * the updated cap. Prevents a weird mid-dictation cutoff when a
   * Stripe webhook lands during an active stream.
   */
  dailyBudgetMs?: number
  /**
   * Accumulated audio duration (ms) forwarded to Cloud STT. Charged as
   * interactions on `close` — 5 per minute (per AGENTS.md §15),
   * realised as `interactionsForAudioMs(ms)` (ceil(ms/12000)).
   *
   * Why on-close rather than per-chunk: chunks are 128 ms each, and 5
   * interactions/minute is 1/12 of a second — 94 out of every 95
   * chunks would round to 0. Accumulating + charging once at the end
   * keeps the atomic increment well-defined and matches the "session
   * cost" mental model better than a per-chunk drip.
   */
  accumulatedAudioMs?: number
  /**
   * Cloud STT stream. Populated in `handleAuth` after the JWT checks
   * out; every code path that reaches for it also checks `authed`.
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

      // Pre-auth branch: must receive a valid `{type:'auth'}` message
      // before we'll accept anything else. Anything non-control (i.e.
      // binary audio) pre-auth is rejected so a malicious client can't
      // ship audio bytes before auth.
      if (!ctx.authed) {
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
        return
      }

      // Post-auth branch. Control frames (`{type:'stop'}`) and audio
      // (raw binary) both land here; the type-parse above routes us.
      if (parsedControl) {
        if (parsedControl.type === 'stop') {
          ctx.sttEnded = true
          try {
            ctx.stt?.end()
          } catch {
            /* best-effort */
          }
        }
        return
      }

      // Drop audio chunks that arrive after `stop`. The browser's
      // AudioWorklet posts to the main thread via postMessage; up to
      // ~128 ms of chunks can be in-flight between "user clicked
      // stop" and "composable disconnected the worklet". Without this
      // guard, each straggler would hit `stt.write(...)` on an ended
      // stream and surface as an "error" frame on the wire.
      if (ctx.sttEnded) return

      if (!ctx.stt) return

      // Debit budget BEFORE forwarding so a burst past the cap can't
      // land free. `remaining` returns in ms (matching the budget's
      // units) so the client can surface a meaningful "minutes left".
      // Budget size comes from the caller's tier, resolved at auth.
      const dailyBudgetMs = ctx.dailyBudgetMs ?? (5 * 60 * 1000)
      const { allowed, remaining } = await consumeRateLimitBudget(
        'ai-dictate-ms',
        String(ctx.userId),
        CHUNK_AUDIO_MS,
        dailyBudgetMs,
        DAILY_WINDOW_MS
      )
      if (!allowed) {
        p.send(encodeServerFrame({ type: 'budget-exhausted', remaining }))
        p.close(4002, 'budget exhausted')
        return
      }

      const raw = message.rawData
      const buf = raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : Buffer.from(raw as Uint8Array)
      try {
        ctx.stt.write(buf)
      } catch (e) {
        console.error('[dictate] stt write failed:', e)
        Sentry.captureException(e, {
          tags: { component: 'dictate', event: 'stt_write_failed' }
        })
        p.send(encodeServerFrame({ type: 'error', message: 'upstream send failed' }))
        p.close(1011, 'stt write failed')
        return
      }

      // Accumulate audio-ms for the interaction charge on close.
      // Done AFTER the write succeeds so a failed chunk doesn't
      // contribute to the bill.
      ctx.accumulatedAudioMs = (ctx.accumulatedAudioMs ?? 0) + CHUNK_AUDIO_MS

      resetIdleTimer(p, ctx)
    },

    close(peer) {
      const ctx = (peer as unknown as PeerLike).context as DictatePeerContext
      ctx.closed = true
      if (ctx.authTimer) clearTimeout(ctx.authTimer)
      if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
      if (ctx.hardCapTimer) clearTimeout(ctx.hardCapTimer)
      try {
        ctx.stt?.destroy()
      } catch {
        /* best-effort */
      }
      if (ctx.userId !== undefined) {
        void releaseSessionLock('ai-dictate-active', String(ctx.userId))
        void finaliseDictateBilling(ctx)
      }
    },

    error(peer, err) {
      console.error('[dictate] ws error:', err)
      Sentry.captureException(err, {
        tags: { component: 'dictate', event: 'ws_error' }
      })
      const ctx = (peer as unknown as PeerLike).context as DictatePeerContext
      ctx.closed = true
      try {
        ctx.stt?.destroy()
      } catch {
        /* best-effort */
      }
      if (ctx.userId !== undefined) {
        void releaseSessionLock('ai-dictate-active', String(ctx.userId))
        void finaliseDictateBilling(ctx)
      }
    }
  }
})

async function handleAuth(
  peer: PeerLike,
  ctx: DictatePeerContext,
  token: unknown,
  languageCode: unknown
) {
  const config = useRuntimeConfig()
  const secret = config.google.dictateJwtSecret || config.jwtSecret
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

  // Resolve the per-tier daily audio budget. If resolution fails (DB
  // blip, missing user row) we close the session rather than silently
  // downgrade to free — billing is a correctness surface, not a rate
  // limit, and mis-reporting caps to the user is worse than refusing
  // to start the session.
  let billing: Awaited<ReturnType<typeof resolveBillingContext>>
  try {
    billing = await resolveBillingContext(payload.userId, null)
  } catch (e) {
    console.error('[dictate] billing resolve failed:', e)
    Sentry.captureException(e, {
      tags: { component: 'dictate', event: 'billing_resolve_failed', userId: String(payload.userId) }
    })
    peer.send(encodeServerFrame({ type: 'error', message: 'Could not resolve billing; please retry.' }))
    peer.close(1011, 'billing resolve failed')
    return
  }
  const dailyBudgetMs = TIERS[billing.plan].dictationMsPerDay
  ctx.dailyBudgetMs = dailyBudgetMs

  // Peek the daily budget (cost: 0 debits nothing, returns remaining).
  const budget = await consumeRateLimitBudget(
    'ai-dictate-ms', String(payload.userId), 0, dailyBudgetMs, DAILY_WINDOW_MS
  )
  if (!budget.allowed || budget.remaining < CHUNK_AUDIO_MS) {
    peer.send(encodeServerFrame({ type: 'budget-exhausted', remaining: budget.remaining }))
    peer.close(4002, 'budget exhausted')
    return
  }

  // Interaction pre-check (re-using the billing resolution above).
  // Reject at open when remaining < 1 so exhausted users don't get
  // audio-worklet spin-up + mic permission prompt before being cut off.
  if (billing.interactionsRemaining <= 0) {
    peer.send(encodeServerFrame({
      type: 'budget-exhausted',
      remaining: 0,
      reason: 'interactions'
    }))
    peer.close(4002, 'interactions exhausted')
    return
  }

  if (!config.google.speechToTextApiKey) {
    peer.send(encodeServerFrame({ type: 'error', message: 'Server misconfigured: missing Speech-to-Text API key' }))
    peer.close(1011, 'no api key')
    return
  }

  const client = createDictateSpeechClient(config.google.speechToTextApiKey)

  // Normalize language: accept either BCP-47 (`de-DE`) or the short
  // ISO 639-1 UI locale (`de`). Defaults to en-US if nothing usable
  // arrived — Cloud STT requires a valid language code or rejects.
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
    peer.send(encodeServerFrame({ type: 'error', message: 'Could not start Speech-to-Text session' }))
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
 *
 * Resolves billing context fresh at close time (no session state
 * for dictation, unlike the prompt loop). Over-cap charges are
 * absorbed — we'd rather over-serve by a few seconds than lose the
 * accounting entirely on a late-stage race.
 */
async function finaliseDictateBilling(ctx: DictatePeerContext): Promise<void> {
  const userId = ctx.userId
  const audioMs = ctx.accumulatedAudioMs ?? 0
  if (userId === undefined || audioMs <= 0) return
  const delta = interactionsForAudioMs(audioMs)
  if (delta <= 0) return
  try {
    const billing = await resolveBillingContext(userId, null)
    await chargeInteractions({
      attributedTo: billing.attributedTo,
      plan: billing.plan,
      delta,
      periodStart: billing.periodStart,
      reason: `dictation ${audioMs}ms`
    })
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      console.warn(`[dictate] [billing] over-cap at session close: ${e.message}`)
      Sentry.captureMessage(`[dictate] over-cap at close: ${e.message}`, {
        level: 'warning',
        tags: { component: 'dictate', event: 'billing_overcap_race', userId: String(userId) }
      })
    } else {
      console.warn('[dictate] [billing] charge failed:', e)
      Sentry.captureException(e, {
        tags: { component: 'dictate', event: 'billing_charge_failed', userId: String(userId) }
      })
    }
  }
}
