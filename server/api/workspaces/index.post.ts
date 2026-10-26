import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { createWorkspace, countOwnedWorkspacesByUser } from '../../repos/workspaces'
import { users } from '../../db/schema'
import { useDatabase } from '../../utils/database'
import type { PlanName } from '~~/shared/config/tiers'
import { getTiers } from '~~/server/utils/tierConfig'
import { effectivePlan, limitRecovery, limitUpgradeHint } from '~~/server/utils/billingMode'
import { DPA_VERSION } from '~~/shared/legal/versions'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const body = await readBody<{ name?: unknown, description?: unknown }>(event)
  const userId = session.user.id

  // Per-user workspace cap, tier-aware. Prevents the "spawn thousands
  // of workspaces to fan out uploads" fan-out vector — each workspace
  // independently has a 1 GB knowledge cap, so without a per-user
  // workspace limit a single account could pin TB of S3. The exact
  // number depends on the plan: Free=1, Pro=10, Max=30, Ultra=100.
  // Lapsed paid plans fall back to free-tier caps defensively.
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
  const acceptedDpa = planRows[0]?.dpaVersionAccepted ?? null
  if (acceptedDpa === null || acceptedDpa < DPA_VERSION) {
    throw createError({
      statusCode: 409,
      message: 'You must accept the Data Processing Addendum (DPA) before creating a workspace.',
      data: {
        code: 'workspace/dpa-required',
        currentDpaVersion: DPA_VERSION
      }
    })
  }

  const owned = await countOwnedWorkspacesByUser(userId)
  if (owned >= cap) {
    throw createError({
      statusCode: 409,
      message: `You've reached the workspace limit for your plan (${cap}, ${plan}). Delete an unused workspace to create a new one. ${limitUpgradeHint()}`,
      data: { code: 'workspace/cap-reached', plan, cap, recovery: limitRecovery() }
    })
  }

  const rawName = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!rawName) throw createError({ statusCode: 400, message: 'Name is required' })
  if (rawName.length > 255) throw createError({ statusCode: 400, message: 'Name too long (max 255)' })

  let description: string | null = null
  if (body?.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      throw createError({ statusCode: 400, message: 'Description must be a string' })
    }
    const trimmed = body.description.trim()
    if (trimmed.length > 1024) {
      throw createError({ statusCode: 400, message: 'Description too long (max 1024)' })
    }
    description = trimmed.length > 0 ? trimmed : null
  }

  const workspaceId = nanoid(10)

  // createWorkspace writes the workspaces row AND the creator's admin
  // membership row in one transaction — neither can land without the
  // other, so the ≥1-admin invariant holds from t=0.
  await createWorkspace({
    workspaceId,
    ownerId: userId,
    name: rawName,
    description
  })

  return { workspaceId }
})
