import { readSessionChannel } from '../../../../utils/agentic/sessionChannel'
import { createSessionEventStream } from '../../../../utils/agentic/sessionStream'

// GET /api/ai/sessions/:sessionId/stream: Server-Sent Events push of the
// initiator's private session view (same JSON as `GET .../:sessionId`):
// `status` on every change, `end` when finished.
// See `server/utils/agentic/sessionStream.ts`.
//
// Same gate as the GET (session cookie, initiator only, 404 otherwise),
// decided BEFORE the stream opens so a refused EventSource fails with a plain
// HTTP error and the client falls back to polling.
//
// `X-Accel-Buffering: no` + `Cache-Control: no-transform` stop buffering or
// compressing proxies from holding events back. Traefik doesn't buffer or
// compress this route. The production entry (`server/runtime/bunEntry.ts`)
// goes through `nitroApp.localFetch`, which passes the ReadableStream through
// untouched, so Bun flushes it itself; pinned by
// `tests/integration/endpoints/aiSessionStream.test.ts`.

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
