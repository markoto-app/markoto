import { acceptInviteForUser, declineInviteForUser, type InviteAccepted, type InviteDeclined } from '../../../utils/workspaces/workspaceInviteActions'
import { hashInviteSecret, parseInviteToken } from '../../../utils/workspaces/workspaceInvites'
import { actOnInviteTokenBody } from '~~/shared/api/account'
import { MINUTE_MS } from '~~/shared/config/units'

// POST /api/user/invites/by-token — act on an invitation from its
// emailed link (`/invites/accept?token=…`). Sign-in required (the
// membership needs an account); the token proves control of the invited
// mailbox, so the account's own email doesn't have to match.
//
// Body: { token: string, action: 'accept' | 'decline' }
// The token is single-use: accepting or declining deletes the invite.
export default defineApiHandler({
  access: allow.user(),
  body: actOnInviteTokenBody,
  rateLimit: { namespace: 'workspace-invite-token', max: 20, windowMs: 10 * MINUTE_MS, key: 'user', error: 'workspace/invite-rate-limited' },
  handler: async ({ event, self, body }): Promise<InviteAccepted | InviteDeclined> => {
    const token = parseInviteToken(body.token)
    if (!token) throw apiError('workspace/invite-not-found')
    const selector = { kind: 'token' as const, tokenHash: hashInviteSecret(token) }

    return body.action === 'accept'
      ? acceptInviteForUser(event, self, selector)
      : declineInviteForUser(event, self, selector)
  }
})
