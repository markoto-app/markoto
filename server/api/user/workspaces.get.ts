import { listWorkspacesForUser } from '../../repos/workspaces'
import { pooledPlansFor } from '../../utils/billing/workspaceBilling'

// Per-user workspace list for the dashboard. Returns every workspace the
// user is a member of (any role), joined with the doc aggregates so the
// client can render counts + "last activity" on each card in a single
// round-trip. The member's role is returned so the UI can tag "Shared" /
// "Viewer" / etc. without a second fetch.
export default defineApiHandler({
  access: allow.user(),
  handler: async ({ self }) => {
    const rows = await listWorkspacesForUser(self)
    // Team / Business plan covering the workspace, for the badge.
    const plans = await pooledPlansFor(rows.map(r => r.workspaceId))
    return rows.map(r => ({ ...r, plan: plans.get(r.workspaceId) ?? null }))
  }
})
