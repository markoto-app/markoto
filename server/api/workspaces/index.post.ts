import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { createWorkspace, countOwnedWorkspacesByUser } from '../../repos/workspaces'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/platform/database'
import type { PlanName } from '~~/shared/config/tiers'
import { getTiers } from '~~/server/utils/billing/tierConfig'
import { effectivePlan, limitRecovery } from '~~/server/utils/billing/billingMode'
import { DPA_VERSION } from '~~/shared/legal/versions'
import { legalSurfacesEnabled } from '~~/server/utils/platform/instanceConfig'
import { createWorkspaceBody } from '~~/shared/api/workspaces'

export default defineApiHandler({
  access: allow.user(),
  body: createWorkspaceBody,
  handler: async ({ user, body }) => {
    const userId = user.id

    // Per-user workspace cap, tier-aware. Prevents the "spawn thousands
    // of workspaces to fan out uploads" fan-out vector — each workspace
    // independently has a 1 GB knowledge cap, so without a per-user
    // workspace limit a single account could pin TB of S3. The exact
    // number depends on the plan: Free=1, Pro=10, Team=30, Business=100.
    // Lapsed paid plans fall back to free-tier caps.
    const db = useDatabase()
    const planRows = await db.select({
      plan: users.plan,
      planValidUntil: users.planValidUntil,
      dpaVersionAccepted: users.dpaVersionAccepted
    }).from(users).where(eq(users.id, userId)).limit(1)
    // Lapsed paid plans and billing-off deployments both resolve to free.
    const plan: PlanName = effectivePlan(planRows[0]?.plan ?? 'free', planRows[0]?.planValidUntil ?? null)
    const cap = getTiers()[plan].workspacesOwned

    // GDPR Article 28 gate: the user is about to become a controller
    // for personal data their workspace members place inside this
    // workspace, and we become their processor. The DPA is the
    // contract that governs that relationship. Refuse workspace
    // creation until they've accepted at the current version. The
    // client-side flow surfaces a `DpaAcceptanceModal` before this
    // POST fires; the server-side check is defence-in-depth so a
    // direct curl can't slip past the consent.
    //
    // Only while the legal surfaces are on (hosted SaaS): the bundled DPA
    // names the hosted operator as processor. A self-hosted instance runs
    // its own contractual setup and shows no DPA step.
    const acceptedDpa = planRows[0]?.dpaVersionAccepted ?? null
    if (legalSurfacesEnabled() && (acceptedDpa === null || acceptedDpa < DPA_VERSION)) {
      throw apiError('workspace/dpa-required', { currentDpaVersion: DPA_VERSION })
    }

    const owned = await countOwnedWorkspacesByUser(userId)
    if (owned >= cap) {
      throw apiError('workspace/cap-reached', { plan, cap, recovery: limitRecovery() })
    }

    const workspaceId = nanoid(10)

    // createWorkspace writes the workspaces row AND the creator's admin
    // membership row in one transaction — neither can land without the
    // other, so the ≥1-admin invariant holds from t=0.
    await createWorkspace({
      workspaceId,
      ownerId: userId,
      name: body.name,
      description: body.description ?? null
    })

    return { workspaceId }
  }
})
