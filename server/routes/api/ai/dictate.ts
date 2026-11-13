import * as Sentry from '@sentry/nuxt'
import { tryParseControl } from '../../../utils/agentic/dictateHelpers'
import { AUTH_DEADLINE_MS, dictateContext, rejectPeer, type PeerLike } from '../../../utils/agentic/dictation/peerContext'
import { handleAudioChunk, handlePostAuthControl, handlePreAuthMessage, releaseDictation } from '../../../utils/agentic/dictation/messageProtocol'
import { encodeServerFrame } from '~~/shared/contracts/dictateWs'
import { useLogger } from '../../../utils/platform/logger'

const log = useLogger('dictate')

// WebSocket relay for live voice dictation. Bridges the browser's PCM
// audio stream to Mistral Voxtral Realtime via the official
// `@mistralai/mistralai/extra/realtime` SDK and forwards transcript
// events back to the client.
//
// The SDK opens a direct WS to Mistral (not through LiteLLM, which
// doesn't proxy stateful WS streams); LiteLLM still sees a per-minute
// billing tick (`voxtral-realtime-tick`) so spend lands on the right
// per-user virtual key.
//
// Wire format:
//   Client → server (JSON, before auth):
//     - `{ type: 'auth', token, languageCode? }`: FIRST message after
//       open. Must arrive within `AUTH_DEADLINE_MS` or we close. Token
//       is the short-lived JWT from POST /api/ai/dictate/token.
//       Passing the token in the first WS MESSAGE (not `?token=` in the
//       URL) avoids leaking it into access logs, referer headers, and
//       browser history: the URL never carries a credential.
//   Client → server (after auth):
//     - binary frames: raw int16 PCM chunks from the AudioWorklet
//       (2048 samples @ 16 kHz = 128 ms per chunk).
//     - `{ type: 'stop' }` JSON: graceful shutdown; caller finalizes.
//   Server → client (JSON, always):
//     - `{ type: 'hello' }` immediately on open, "send auth now"
//     - `{ type: 'ready' }` after auth + STT stream up, "send audio now"
//     - `{ type: 'partial', text }` interim transcripts
//     - `{ type: 'final', text }` finalized phrases
//     - `{ type: 'error', message }` fatal; socket closes next
//     - `{ type: 'budget-exhausted', remaining }` LiteLLM budget used up
//     - `{ type: 'session-cap' }` per-session 10 min cap
//     - `{ type: 'idle-timeout' }` 30 s without audio
//
// Spend is capped by the LiteLLM budget (voice ticks, `dictation/voiceTicks.ts`); there is no
// separate audio cap. Other guards: one session per user, idle timeout,
// session hard cap.
//
// This file is the socket's hooks; the protocol, auth, upstream stream and
// billing ticks are `server/utils/agentic/dictation/`.

// The one-session-per-user cap is a Valkey lock (see
// `tryAcquireSessionLock`), not an in-memory Set: two tabs on different
// workers would both slip past a per-process Set. The lock TTL is
// `SESSION_HARD_CAP_MS`, so a crashed process releases it on its own.

export default defineEventHandler({
  handler() {
    throw createError({ statusCode: 426, message: 'Upgrade Required: WebSocket only' })
  },

  websocket: {
    // Auth happens in the first WS message so the JWT never appears in
    // the URL. crossws's upgrade hook gets a raw Request with no
    // Authorization header support, so it can't authenticate. The socket
    // is closed after `AUTH_DEADLINE_MS` if nothing valid arrives.
    upgrade() {
      // Intentionally empty: every connection is allowed to OPEN.
      // Authentication + user binding happen in the `message` hook
      // below; the `open` hook arms a deadline that closes the socket
      // if no valid auth arrives in time.
    },

    open(peer) {
      const p: PeerLike = peer
      const ctx = dictateContext(p)
      p.send(encodeServerFrame({ type: 'hello' }))
      ctx.authTimer = setTimeout(() => {
        if (!ctx.authed) rejectPeer(p, 'Auth timeout', 4000, 'auth timeout')
      }, AUTH_DEADLINE_MS)
    },

    async message(peer, message) {
      const p: PeerLike = peer
      const ctx = dictateContext(p)
      if (ctx.closed) return

      // Text-vs-binary detection is tricky with crossws over the Node
      // `ws` library: text frames arrive as Buffer too, so `typeof
      // rawData === 'string'` is not reliable. We distinguish by
      // trying to parse the frame as JSON via `message.text()`, a
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
      const ctx = dictateContext(peer)
      ctx.closed = true
      if (ctx.authTimer) clearTimeout(ctx.authTimer)
      if (ctx.idleTimer) clearTimeout(ctx.idleTimer)
      if (ctx.hardCapTimer) clearTimeout(ctx.hardCapTimer)
      releaseDictation(ctx)
    },

    error(peer, err) {
      log.error('ws error', { err })
      Sentry.captureException(err, {
        tags: { component: 'dictate', event: 'ws_error' }
      })
      const ctx = dictateContext(peer)
      ctx.closed = true
      releaseDictation(ctx)
    }
  }
})
