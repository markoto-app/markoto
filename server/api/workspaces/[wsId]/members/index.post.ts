import { inviteMemberBody } from '~~/shared/api/workspaces'
import { checkRateLimit } from '../../../../utils/platform/rateLimit'
import {
  WORKSPACE_INVITE_PER_ADMIN_LIMIT,
  WORKSPACE_INVITE_PER_WORKSPACE_LIMIT,
  WORKSPACE_INVITE_WINDOW_MS,
  normaliseInviteEmail
} from '../../../../utils/workspaces/workspaceInvites'
import { inviteWorkspaceMember } from '../../../../utils/workspaces/inviteMember'

// POST /api/workspaces/:wsId/members: invite someone by email. Admin-only.
//
// Creates (or refreshes) a PENDING invite; nobody becomes a member here.
// The invitee accepts in-app (the invite matches the verified email on
// their account) or through the emailed link, see
// `/api/user/invites/*`. So:
//   - The response is the same `202 { ok: true }` whether or not the
//     address belongs to an account, and carries no profile data (no
//     account-existence / PII oracle).
//   - Only an address that is ALREADY a member of this workspace is
//     refused (409): the admin can see the member list anyway.
//
// Abuse limits: per-admin and per-workspace hourly rate limits (429), a
// cap on open invites per workspace (409 `workspace/invite-cap`), and at
// most 3 invite emails per address per day (beyond that the invite is
// still recorded but no email goes out, same 202). The invite itself
// (limits, seats, email, audit): `utils/workspaces/inviteMember.ts`.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'workspace/admin-required' }),
  body: inviteMemberBody,
  handler: async ({ event, user, self, wsId, body, workspaceAccess }) => {
    const email = normaliseInviteEmail(body.email)
    if (!email) throw apiError('workspace/invalid-email')

    // Inline, after the address check: a mistyped address must not spend
    // the admin's or the workspace's hourly invite budget.
    if (!(await checkRateLimit('workspace-invite-user', String(user.id), WORKSPACE_INVITE_PER_ADMIN_LIMIT, WORKSPACE_INVITE_WINDOW_MS))
      || !(await checkRateLimit('workspace-invite-ws', wsId, WORKSPACE_INVITE_PER_WORKSPACE_LIMIT, WORKSPACE_INVITE_WINDOW_MS))) {
      throw apiError('workspace/invite-rate-limited')
    }

    await inviteWorkspaceMember(event, {
      ws: workspaceAccess,
      inviter: { self, name: user.name },
      email,
      // Default role for new invites is 'editor', the most common case.
      role: body.role ?? 'editor',
      addSeat: body.addSeat === true
    })

    setResponseStatus(event, 202)
    return { ok: true, invited: true }
  }
})
