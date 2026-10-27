import { readSessionChannel } from '../../../../utils/agentic/sessionChannel'
import { createSessionEventStream } from '../../../../utils/agentic/sessionStream'

// GET /api/ai/sessions/:sessionId/stream — Server-Sent Events push of the
// initiator's private session view (same JSON as `GET …/:sessionId`):
// `status` events on every change, `end` when the session is finished.
// See `server/utils/agentic/sessionStream.ts`.
//
// Same gate as the GET: session cookie required, initiator only, 404
// for anybody else and for unknown / expired sessions — decided BEFORE
// the stream opens, so a refused EventSource fails with a plain HTTP
// error (the client then falls back to polling, which 404s too).
//
// Proxies: `X-Accel-Buffering: no` + `Cache-Control: no-transform`
// keep buffering / compressing proxies from holding events back.
// Traefik (prod + self-host) streams responses unbuffered: its
// `buffering` middleware is only attached to `/api/import`, no `compress`
// middleware is configured, and Go's reverse proxy flushes
// `text/event-stream` responses immediately. CSP `connect-src 'self'`
// covers the same-origin EventSource. The production entry
// (`server/runtime/bunEntry.ts`) goes through `nitroApp.localFetch`,
// whose mock Node response passes the ReadableStream through untouched
// (h3 `sendStream` without a socket), so Bun receives — and flushes —
// the stream itself; pinned by
// `tests/integration/endpoints/aiSessionStream.test.ts` against the
// production build.

const SESSION_ID_RE = /^[\w-]{1,64}$/

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const sessionId = getRouterParam(event, 'sessionId') ?? ''
  if (!SESSION_ID_RE.test(sessionId)) {
    throw createError({ statusCode: 400, message: 'Invalid sessionId' })
  }
  const snapshot = await readSessionChannel(sessionId)
  if (snapshot?.initiatorUserId !== session.user.id) {
    throw createError({ statusCode: 404, message: 'AI session not found', data: { code: 'ai/session-not-found' } })
  }
  const body = createSessionEventStream({ sessionId, userId: session.user.id })
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no'
    }
  })
})
