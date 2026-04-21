import { listWorkspacesForUser } from '../../repos/workspaces'

// Per-user workspace list for the dashboard. Returns every workspace the
// user is a member of (any role), joined with the doc aggregates so the
// client can render counts + "last activity" on each card in a single
// round-trip. The member's role is returned so the UI can tag "Shared" /
// "Viewer" / etc. without a second fetch.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  return listWorkspacesForUser(session.user.id)
})
