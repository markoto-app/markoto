import { eq } from 'drizzle-orm'
import { users } from '../../../db/schema'
import { useDatabase } from '../../../utils/database'
import { getWorkspace, setWorkspaceBilling } from '../../../repos/workspaces'

// PATCH /api/workspaces/:wsId/billing — toggle (+) team-billing on a
// workspace.
//
// Authz + plan rules:
//   - Admin-only. Editors/viewers can't change who pays.
//   - Enabling requires the CALLER's plan to be max or ultra and not
//     lapsed. Pro is deliberately personal-only — an attempt to enable
//     from a Pro account returns 403 with the upgrade hint.
//   - The billing owner is set to the CALLER's user id. We don't let
//     admins designate someone else as the payer — that would let one
//     admin drain another user's pool without explicit consent.
//   - Disabling is always allowed (any admin can turn off `(+)` at
//     any time, regardless of their own plan). Mirrors the "deactivate
//     is instant" property from AGENTS.md §7 "Billing (Stripe +
//     LiteLLM)" / server/utils/AGENTS.md.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const body = await readBody<{ aiEnabled?: unknown }>(event)

  if (typeof body?.aiEnabled !== 'boolean') {
    throw createError({ statusCode: 400, message: 'aiEnabled must be a boolean' })
  }

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can change billing settings' })
  }

  // 404 guard — if the workspace row itself is gone between the role
  // lookup and the write, surface cleanly rather than upserting.
  const ws = await getWorkspace(wsId)
  if (!ws) throw createError({ statusCode: 404, message: 'Workspace not found' })

  if (body.aiEnabled) {
    // Enable (+). Plan gate: max/ultra + not lapsed.
    const db = useDatabase()
    const rows = await db.select({
      plan: users.plan,
      planValidUntil: users.planValidUntil
    }).from(users).where(eq(users.id, session.user.id)).limit(1)
    const callerPlan = (rows[0]?.plan ?? 'free')
    const validUntil = rows[0]?.planValidUntil ?? null

    if (callerPlan !== 'max' && callerPlan !== 'ultra') {
      throw createError({
        statusCode: 403,
        message: 'Team billing (+) requires Max or Ultra plan. Upgrade at /pricing to enable.',
        data: { callerPlan }
      })
    }
    if (validUntil !== null && validUntil.getTime() <= Date.now()) {
      throw createError({
        statusCode: 403,
        message: 'Your paid plan has lapsed. Renew at /pricing to enable team billing.',
        data: { callerPlan, planValidUntil: validUntil.toISOString() }
      })
    }

    await setWorkspaceBilling(wsId, {
      aiEnabled: true,
      billingOwnerId: session.user.id
    })
    return {
      success: true,
      aiEnabled: true,
      billingOwnerId: session.user.id,
      billingOwnerPlan: callerPlan
    }
  }

  // Disable (+). No plan check — any admin can turn it off. Null the
  // owner too so the resolver's fallback-to-self-bill path doesn't keep
  // pointing at a stale id after someone toggles off.
  await setWorkspaceBilling(wsId, {
    aiEnabled: false,
    billingOwnerId: null
  })
  return {
    success: true,
    aiEnabled: false,
    billingOwnerId: null
  }
})
