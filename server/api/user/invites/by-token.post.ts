import { acceptInviteForUser, declineInviteForUser } from '../../../utils/workspaces/workspaceInviteActions'
import { hashInviteSecret, parseInviteToken } from '../../../utils/workspaces/workspaceInvites'

// POST /api/user/invites/by-token — act on an invitation from its
// emailed link (`/invites/accept?token=…`). Sign-in required (the
// membership needs an account); the token proves control of the invited
// mailbox, so the account's own email doesn't have to match.
//
// Body: { token: string, action: 'accept' | 'decline' }
// The token is single-use: accepting or declining deletes the invite.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)

  if (!(await checkRateLimit('workspace-invite-token', String(session.user.id), 20, 10 * 60 * 1000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many attempts. Try again later.',
      data: { code: 'workspace/invite-rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<{ token?: unknown, action?: unknown }>(event)
  const token = parseInviteToken(body?.token)
  if (!token) {
    throw createError({
      statusCode: 404,
      message: 'Invitation not found or expired',
      data: { code: 'workspace/invite-not-found', messageKey: 'workspace.invites.errors.notFound' }
    })
  }
  const selector = { kind: 'token' as const, tokenHash: hashInviteSecret(token) }

  if (body?.action === 'accept') return acceptInviteForUser(event, session.user.id, selector)
  if (body?.action === 'decline') return declineInviteForUser(event, session.user.id, selector)
  throw createError({ statusCode: 400, message: 'Invalid action' })
})
