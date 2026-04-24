import * as Sentry from '@sentry/nuxt'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { workspaces, users } from '../db/schema'
import { useDatabase } from './database'

// Plan-lapse sweep logic. Standalone module (not inside the plugin
// file) so tests can import it without triggering `defineNitroPlugin`,
// which is a Nitro auto-import unavailable in the repo-test context.
//
// Disables `(+)` team-billing on any workspace whose billing owner has:
//   (a) deleted their account — `ON DELETE SET NULL` nulled the FK but
//       `ai_enabled` stayed true;
//   (b) lapsed — `planValidUntil < now()`;
//   (c) downgraded to Pro/Free — only max/ultra can team-bill.
//
// The billing resolver already falls back to self-bill for these
// cases at runtime; this sweep is belt-and-braces for DB state +
// admin UI "`(+)` enabled" badges.

/** Returns the number of workspaces that had `(+)` turned off. */
export async function runPlanLapseSweep(): Promise<number> {
  const db = useDatabase()
  let disabled = 0
  try {
    // Case (a): billing_owner_id nulled but ai_enabled still true.
    const caseA = await db.update(workspaces).set({
      aiEnabled: false,
      billingOwnerId: null
    }).where(and(
      eq(workspaces.aiEnabled, true),
      isNull(workspaces.billingOwnerId)
    )).returning({ id: workspaces.workspaceId })
    disabled += caseA.length

    // Cases (b) + (c): billing owner's plan is lapsed OR downgraded
    // below team-billing eligibility. Select candidates then
    // filter-and-null one by one.
    const now = new Date()
    const candidates = await db.select({
      workspaceId: workspaces.workspaceId,
      ownerPlan: users.plan,
      ownerPlanValidUntil: users.planValidUntil
    })
      .from(workspaces)
      .innerJoin(users, eq(users.id, workspaces.billingOwnerId))
      .where(and(
        eq(workspaces.aiEnabled, true),
        isNotNull(workspaces.billingOwnerId)
      ))

    const stale = candidates.filter((c) => {
      if (c.ownerPlan !== 'max' && c.ownerPlan !== 'ultra') return true
      if (c.ownerPlanValidUntil !== null && c.ownerPlanValidUntil < now) return true
      return false
    })

    for (const row of stale) {
      console.log(`[plan-lapse-sweep] disabling (+) on ${row.workspaceId} (ownerPlan=${row.ownerPlan}, validUntil=${row.ownerPlanValidUntil?.toISOString() ?? 'null'})`)
      await db.update(workspaces).set({
        aiEnabled: false,
        billingOwnerId: null
      }).where(eq(workspaces.workspaceId, row.workspaceId))
      disabled += 1
    }
  } catch (e) {
    console.warn('[plan-lapse-sweep] sweep failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'plan-lapse-sweep', event: 'sweep_failed' } })
  }
  return disabled
}
