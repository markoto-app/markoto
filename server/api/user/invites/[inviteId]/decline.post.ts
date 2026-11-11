import { declineInviteForUser, inAppInviteSelector } from '../../../../utils/workspaces/workspaceInviteActions'
import { inviteParams } from '~~/shared/api/account'

// POST /api/user/invites/:inviteId/decline — decline (delete) an
// invitation addressed to the signed-in user's account email.
export default defineApiHandler({
  access: allow.user(),
  params: inviteParams,
  body: 'none',
  handler: async ({ event, user, params }) => {
    const selector = await inAppInviteSelector(user.id, params.inviteId)
    return declineInviteForUser(event, user.id, selector)
  }
})
