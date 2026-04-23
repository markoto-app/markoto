import { GoogleGenAI, Modality, type Session } from '@google/genai'
import jwt from 'jsonwebtoken'
import { consumeRateLimitBudget } from '../../../utils/rateLimit'

// WebSocket relay for live voice dictation. Bridges the browser's PCM
// audio stream to Gemini's Live API and forwards `inputTranscription`
// events back to the client.
//
// Wire format:
//   Client → server:
//     - binary frames: raw int16 PCM chunks from the AudioWorklet (2048
//       samples @ 16kHz = 128ms per chunk).
//     - `{ type: 'stop' }` JSON: graceful shutdown after the final chunk
//   Server → client (JSON, always):
//     - `{ type: 'ready' }`: Gemini session is up — start sending audio
//     - `{ type: 'partial', text }`: interim transcript (may be revised)
//     - `{ type: 'final', text }`: finalized phrase, safe to commit
//     - `{ type: 'error', message }`: fatal; the socket will close next
//     - `{ type: 'budget-exhausted', remaining }`: daily budget used up
//     - `{ type: 'session-cap' }`: 10-minute per-session cap reached
//     - `{ type: 'idle-timeout' }`: no audio for 30s — session closed
//
// Auth: the upgrade URL carries a short-lived JWT minted by
// POST /api/ai/dictate/token. crossws's upgrade hook only has access
// to a raw Request (not an H3Event), so reading the sealed session
// cookie directly isn't an option — the JWT route keeps things simple
// and parallels Hocuspocus authentication.
//
// Rate-limiting: dictation is billed by the SECOND, not per request.
// Every audio chunk (128ms @ 16kHz) debits `CHUNK_SEC` seconds from
// the user's daily budget; when exhausted we close the session with
// a structured `budget-exhausted` message so the client can surface
// a friendly error. See `consumeRateLimitBudget` for the sliding-
// window math.

// Daily budget in seconds. 1800s = 30 minutes — conservative initial
// cap while the feature is new. Bump once we have real usage data.
const DAILY_BUDGET_SEC = 1800
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000

// Per-session hard cap. Prevents a forgotten-mic-on scenario from
// silently burning through the daily budget.
const SESSION_HARD_CAP_MS = 10 * 60 * 1000

// Idle timeout — no audio chunk for this many ms → auto-close. The
// user's MediaRecorder may stop emitting chunks if the tab goes
// background; a stuck Gemini session left open would keep billing.
const IDLE_TIMEOUT_MS = 30_000

// Each AudioWorklet chunk is 2048 int16 samples at 16kHz = 0.128s audio.
// Precomputed so we can debit precisely without inferring from byte
// length (which varies with frame boundaries).
const CHUNK_SEC = 2048 / 16000

interface DictatePeerContext {
  userId?: number
  docId?: string
  gemini?: Session
  closed?: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  hardCapTimer?: ReturnType<typeof setTimeout>
  // Accumulated interim transcript for the current turn. Gemini's
  // `inputTranscription.text` arrives as incremental CHUNKS (not
  // monotonic snapshots), and `turnComplete` fires in its OWN message
  // with no transcription field. So we concatenate chunks here, emit
  // each running total as a `partial` to the client, and when
  // `turnComplete` lands we flush the whole buffer as `final` and
  // reset. Without this, `final` never fires and nothing commits to
  // the doc.
  transcriptBuffer?: string
}

// Narrow peer surface — peer implementations from different adapters
// share `send`/`close`/`context` but differ on niche methods we don't
// use. Keeping this tight avoids TS fighting with the Peer type.
interface PeerLike {
  send: (data: string) => unknown
  close: (code?: number, reason?: string) => void
  context: Record<string, unknown>
}

export default defineEventHandler({
  // Plain HTTP GET/POST bounces — this route is WS-only.
  handler() {
    throw createError({ statusCode: 426, message: 'Upgrade Required: WebSocket only' })
  },

  websocket: {
    // Upgrade runs before the socket is promoted. Parse the JWT off
    // `?token=X` and reject unauthorized clients with 401. Passing
    // `userId`/`docId` through `context` lets later hooks skip re-
    // verifying the token.
    async upgrade(request) {
      const config = useRuntimeConfig()
      if (!config.jwtSecret) {
        throw createError({ statusCode: 500, message: 'JWT secret not configured' })
      }
      const url = new URL(request.url)
      const token = url.searchParams.get('token')
      if (!token) {
        throw createError({ statusCode: 401, message: 'Missing token' })
      }
      let payload: { userId?: number, docId?: string, kind?: string }
      try {
        payload = jwt.verify(token, config.jwtSecret) as typeof payload
      } catch {
        throw createError({ statusCode: 401, message: 'Invalid or expired token' })
      }
      if (payload.kind !== 'dictate' || typeof payload.userId !== 'number' || typeof payload.docId !== 'string') {
        throw createError({ statusCode: 401, message: 'Malformed dictation token' })
      }
      return {
        context: { userId: payload.userId, docId: payload.docId } satisfies DictatePeerContext as Record<string, unknown>
      }
    },

    async open(peer) {
      const ctx = (peer as unknown as PeerLike).context as DictatePeerContext
      const userId = ctx.userId!

      // Up-front budget check. `cost: 0` peeks the remaining balance
      // without spending anything — avoids a pointless Gemini roundtrip
      // for a user who's already over their daily cap.
      const { allowed, remaining } = await consumeRateLimitBudget(
        'ai-dictate-sec', String(userId), 0, DAILY_BUDGET_SEC, DAILY_WINDOW_MS
      )
      if (!allowed || remaining < 1) {
        (peer as unknown as PeerLike).send(JSON.stringify({ type: 'budget-exhausted', remaining }))
        ;(peer as unknown as PeerLike).close(4002, 'budget exhausted')
        return
      }

      const config = useRuntimeConfig()
      if (!config.google.apiKey) {
        (peer as unknown as PeerLike).send(JSON.stringify({ type: 'error', message: 'Server misconfigured' }))
        ;(peer as unknown as PeerLike).close(1011, 'no api key')
        return
      }

      const ai = new GoogleGenAI({ apiKey: config.google.apiKey })
      try {
        const gemini = await ai.live.connect({
          model: config.google.liveModel,
          config: {
            // `gemini-3.1-flash-live-preview` requires an AUDIO
            // modality — the API errors with a generic "Internal
            // error" on text-only. We request AUDIO (the default)
            // to satisfy the validator, then IGNORE any audio parts
            // that come back on the server side; we only forward
            // `inputAudioTranscription` messages (the user's speech
            // transcribed) to the client. Pricier in theory (the
            // model still generates responses), but the VAD-based
            // server only responds if the input is conversational
            // and we pass a system instruction asking it to stay
            // silent.
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            systemInstruction: 'You are a silent transcription relay. Do not generate any spoken or written response. Only listen to the user and transcribe their speech.'
          },
          callbacks: {
            onopen: () => {
              (peer as unknown as PeerLike).send(JSON.stringify({ type: 'ready' }))
            },
            onmessage: (msg) => {
              // Gemini's input-transcription protocol:
              //  - `inputTranscription.text` arrives in SMALL CHUNKS,
              //    each a delta (NOT a full snapshot).
              //  - `turnComplete: true` arrives in its OWN message,
              //    typically WITHOUT an `inputTranscription` field,
              //    once the server-side VAD detects end of speech.
              // Accumulate deltas into `transcriptBuffer`; emit the
              // running total as `partial` so the client's ghost text
              // keeps growing; when `turnComplete` arrives, flush the
              // buffer as `final` and reset for the next turn.
              const delta = msg.serverContent?.inputTranscription?.text
              if (delta) {
                ctx.transcriptBuffer = (ctx.transcriptBuffer ?? '') + delta
                ;(peer as unknown as PeerLike).send(JSON.stringify({
                  type: 'partial',
                  text: ctx.transcriptBuffer
                }))
              }
              if (msg.serverContent?.turnComplete && ctx.transcriptBuffer) {
                (peer as unknown as PeerLike).send(JSON.stringify({
                  type: 'final',
                  text: ctx.transcriptBuffer
                }))
                ctx.transcriptBuffer = ''
              }
            },
            onerror: (err) => {
              console.error('[dictate] gemini error:', err)
              if (!ctx.closed) {
                (peer as unknown as PeerLike).send(JSON.stringify({ type: 'error', message: 'transcription error' }))
                ;(peer as unknown as PeerLike).close(1011, 'gemini error')
              }
            },
            onclose: (ev) => {
              const info = ev as { code?: number, reason?: string } | undefined
              if (!ctx.closed) {
                // Propagate the reason to the client so a downstream
                // failure (model name invalid, quota exhausted, etc.)
                // surfaces as a usable error instead of a silent
                // 1000 close.
                try {
                  (peer as unknown as PeerLike).send(JSON.stringify({
                    type: 'error',
                    message: `Gemini closed: ${info?.reason ?? 'unknown'}`
                  }))
                } catch { /* best-effort */ }
                ;(peer as unknown as PeerLike).close(1000, 'gemini closed')
              }
            }
          }
        })
        ctx.gemini = gemini
      } catch (e) {
        console.error('[dictate] live.connect failed:', e)
        (peer as unknown as PeerLike).send(JSON.stringify({ type: 'error', message: 'Could not start Gemini Live session' }))
        ;(peer as unknown as PeerLike).close(1011, 'gemini connect failed')
        return
      }

      // Hard cap + idle timer. Both call `close()` through the SAME
      // `close` hook below, so Gemini session cleanup is centralised.
      ctx.hardCapTimer = setTimeout(() => {
        (peer as unknown as PeerLike).send(JSON.stringify({ type: 'session-cap' }))
        ;(peer as unknown as PeerLike).close(4003, 'session cap')
      }, SESSION_HARD_CAP_MS)
      resetIdleTimer(peer as unknown as PeerLike, ctx)
    },

    async message(peer, message) {
      const ctx = (peer as unknown as PeerLike).context as DictatePeerContext
      if (ctx.closed || !ctx.gemini) return

      // Control frames come as text (JSON). Audio arrives as binary.
      // We can't just `message.text()` the audio — it'd corrupt the
      // bytes — so we branch on message type via `rawData`.
      if (typeof message.rawData === 'string') {
        try {
          const parsed = JSON.parse(message.rawData) as { type?: string }
          if (parsed.type === 'stop') {
            try { ctx.gemini.close() } catch { /* best-effort */ }
          }
        } catch { /* ignore malformed control frames */ }
        return
      }

      // Binary frame — int16 PCM from the AudioWorklet. Debit budget
      // BEFORE forwarding so a burst can't land free.
      const { allowed, remaining } = await consumeRateLimitBudget(
        'ai-dictate-sec',
        String(ctx.userId),
        // consumeRateLimitBudget expects integer cost; convert our
        // fractional chunk-seconds to ms and let the daily budget be
        // billed in ms-of-audio for precision. 1800s * 1000 = 1.8M ms.
        Math.ceil(CHUNK_SEC * 1000),
        DAILY_BUDGET_SEC * 1000,
        DAILY_WINDOW_MS
      )
      if (!allowed) {
        (peer as unknown as PeerLike).send(JSON.stringify({ type: 'budget-exhausted', remaining: Math.floor(remaining / 1000) }))
        ;(peer as unknown as PeerLike).close(4002, 'budget exhausted')
        return
      }

      const raw = message.rawData
      const buf = raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : Buffer.from(raw as Uint8Array)
      try {
        ctx.gemini.sendRealtimeInput({
          audio: {
            data: buf.toString('base64'),
            mimeType: 'audio/pcm;rate=16000'
          }
        })
      } catch (e) {
        console.error('[dictate] sendRealtimeInput failed:', e)
        (peer as unknown as PeerLike).send(JSON.stringify({ type: 'error', message: 'upstream send failed' }))
        ;(peer as unknown as PeerLike).close(1011, 'upstream send failed')
        return
      }

      resetIdleTimer(peer as unknown as PeerLike, ctx)
    },

    close(peer) {
      const ctx = (peer as unknown as PeerLike).context as DictatePeerContext
      ctx.closed = true
      if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
      if (ctx.hardCapTimer) clearTimeout(ctx.hardCapTimer)
      try { ctx.gemini?.close() } catch { /* best-effort */ }
    },

    error(peer, err) {
      console.error('[dictate] ws error:', err)
      const ctx = (peer as unknown as PeerLike).context as DictatePeerContext
      ctx.closed = true
      try { ctx.gemini?.close() } catch { /* best-effort */ }
    }
  }
})

function resetIdleTimer(peer: PeerLike, ctx: DictatePeerContext) {
  if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
  ctx.idleTimer = setTimeout(() => {
    peer.send(JSON.stringify({ type: 'idle-timeout' }))
    peer.close(4001, 'idle timeout')
  }, IDLE_TIMEOUT_MS)
}
