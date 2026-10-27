import { answerSessionConfirmation, readSessionChannel } from '../../../../utils/agentic/sessionChannel'

// POST /api/ai/sessions/:sessionId/confirm — { confirmationId, allow }
//
// The initiator's answer to a confirmation request raised by the taint
// gate (`server/utils/agentic/crossBoundary.ts`): "markoto wants to read
// 'Q3 plan' — Allow / Deny". Initiator only (404 for anybody else, like
// the GET). 409 when the confirmation is no longer pending (already
// answered, timed out — a timeout counts as deny — or a stale id).

const ID_RE = /^[\w-]{1,64}$/

function field(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null || !(key in body)) return undefined
  return (body as Record<string, unknown>)[key]
}

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const sessionId = getRouterParam(event, 'sessionId') ?? ''
  if (!ID_RE.test(sessionId)) {
    throw createError({ statusCode: 400, message: 'Invalid sessionId' })
  }
  const body: unknown = await readBody(event)
  const confirmationId = field(body, 'confirmationId')
  const allow = field(body, 'allow')
  if (typeof confirmationId !== 'string' || !ID_RE.test(confirmationId) || typeof allow !== 'boolean') {
    throw createError({ statusCode: 400, message: 'Expected { confirmationId: string, allow: boolean }' })
  }
  const snapshot = await readSessionChannel(sessionId)
  if (snapshot?.initiatorUserId !== session.user.id) {
    throw createError({ statusCode: 404, message: 'AI session not found', data: { code: 'ai/session-not-found' } })
  }
  const recorded = await answerSessionConfirmation(sessionId, confirmationId, allow)
  if (!recorded) {
    throw createError({ statusCode: 409, message: 'This request is no longer waiting for an answer.', data: { code: 'ai/confirmation-not-pending' } })
  }
  return { ok: true }
})
