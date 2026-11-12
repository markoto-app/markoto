import { acceptInviteForUser, inAppInviteSelector } from '../../../../utils/workspaces/workspaceInviteActions'
import { inviteParams } from '~~/shared/api/account'

// POST /api/user/invites/:inviteId/accept: accept an invitation
// addressed to the signed-in user's account email. Creates the
// workspace membership with the invited role (an existing membership is
// left as it is) and deletes the invite. 404 when the invite isn't
// addressed to this account, is expired, or doesn't exist.
export default defineApiHandler({
  access: allow.user(),
  params: inviteParams,
  body: 'none',
  handler: async ({ event, params, self }) => {
    const selector = await inAppInviteSelector(self, params.inviteId)
    return acceptInviteForUser(event, self, selector)
  }
})
