import { countBrandAssets } from '../../../repos/brandAssets'
import { countWorkspaceTemplates } from '../../../repos/workspaceTemplates'
import { getWorkspace } from '../../../repos/workspaces'
import { listWorkspaceDocsWithOwnerFlag } from '../../../repos/documents'
import { listMembers } from '../../../repos/workspaceMembers'
import { planHasFeature, resolveWorkspacePlan } from '../../../utils/billing/entitlements'
import { getSsoConnectionForWorkspace } from '../../../repos/sso'
import { countSeatsUsed, getPooledWorkspace } from '../../../utils/billing/workspaceBilling'
import { getWorkspaceSubscription } from '../../../repos/workspaceSubscriptions'
import { isBillingEnabled } from '../../../utils/billing/billingMode'

// Workspace detail. Gated by membership (any role). Returns the workspace
// row, the complete doc list (every doc in the workspace, not just the
// caller's), plus the members list so the UI can render the avatar bar +
// manage-members modal in a single fetch.
//
// Per-doc ownership is surfaced via `isOwner` so the UI can gate the delete
// button for editors (who can only delete their own docs).

export default defineApiHandler({
  // A member of a workspace that enforces single sign-on, without a current
  // sign-in through it, gets 403 `sso/required` with the sign-in link; anyone
  // else without a role gets 404 so membership isn't enumerable.
  access: allow.workspace('member', { ssoHint: true }),
  handler: async ({ wsId, role: myRole, workspaceAccess }) => {
    const ws = await getWorkspace(workspaceAccess)
    if (!ws) throw apiError('workspace/not-found')

    const [documents, members, pool] = await Promise.all([
      listWorkspaceDocsWithOwnerFlag(workspaceAccess),
      listMembers(workspaceAccess),
      getPooledWorkspace(wsId)
    ])
    // Team / Business, admins only: the seat counter in the invite
    // dialog and the payment-problem notice in the header. Members never
    // see billing state.
    let billing: { seats: number, seatsUsed: number, status: string, plan: string, interval: string, currency: string } | null = null
    if (myRole === 'admin' && isBillingEnabled()) {
      const sub = pool?.subscription ?? await getWorkspaceSubscription(wsId)
      if (sub?.stripeSubscriptionId) billing = {
        seats: sub.seats,
        seatsUsed: await countSeatsUsed(workspaceAccess),
        status: sub.status,
        plan: sub.plan,
        interval: sub.interval,
        currency: sub.currency
      }
    }

    // Single sign-on, admins only: whether the SSO tab is shown
    // (the plan includes it, or a connection exists to switch off).
    let sso: { available: boolean, status: 'none' | 'draft' | 'active' } | null = null
    // Audit log, admins only: whether the plan includes the viewer.
    let auditLog: { available: boolean } | null = null
    // Guests, admins only: whether guests can be invited.
    let guests: { available: boolean } | null = null
    // Brand kit, admins only: the tab shows where the plan includes
    // it, or where something is set up that can still be removed.
    let brandKit: { available: boolean, inUse: boolean } | null = null
    if (myRole === 'admin') {
      const plan = await resolveWorkspacePlan(wsId)
      const connection = await getSsoConnectionForWorkspace(wsId)
      sso = { available: planHasFeature(plan, 'sso'), status: connection?.status ?? 'none' }
      auditLog = { available: planHasFeature(plan, 'auditLog') }
      guests = { available: planHasFeature(plan, 'guests') }
      brandKit = {
        available: planHasFeature(plan, 'brandKit'),
        inUse: ws.brandLocked || (await countBrandAssets(workspaceAccess, 'font')) + (await countBrandAssets(workspaceAccess, 'image')) + (await countWorkspaceTemplates(workspaceAccess)) > 0
      }
    }

    return {
      workspace: {
        workspaceId: ws.workspaceId,
        name: ws.name,
        description: ws.description,
        createdAt: ws.createdAt,
        myRole,
        ownerId: ws.ownerId,
        // The workspace's effective plan (Team / Business subscription,
        // else its creator's personal plan, server/utils/billing/entitlements.ts).
        plan: await resolveWorkspacePlan(ws.workspaceId),
        // Default theme used by NewDocumentDialog when creating a doc in
        // this workspace. NULL = use the global markoto preset. Surfaced
        // to all members so the new-doc dialog seeds correctly even for
        // editors/viewers (visibility ≠ ability to change it).
        defaultTheme: ws.defaultTheme,
        // Whether a Team / Business subscription currently covers it.
        pooled: pool !== null,
        billing,
        sso,
        auditLog,
        guests,
        brandKit,
        brandLocked: ws.brandLocked
      },
      documents,
      members
    }
  }
})
