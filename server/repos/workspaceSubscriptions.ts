import { eq, inArray, sql, type SQL } from 'drizzle-orm'
import { workspaceSubscriptions, workspaceMembers } from '../db/schema'
import { useDatabase } from '../utils/database'
import type { WorkspacePlanName } from '../../shared/config/tiers'

// Team / Business subscriptions of workspaces (pricing plan WS2). Stripe
// writes every row through the webhook (WP2/WP3); the rest of the app
// only reads them, through `resolveWorkspacePlan`
// (server/utils/entitlements.ts).

export interface WorkspaceSubscriptionRow {
  workspaceId: string
  plan: WorkspacePlanName
  seats: number
  status: string
  billingAdminId: number | null
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodStart: Date | null
  validUntil: Date | null
  litellmTeamId: string | null
  budgetSeatAdjust: number
  budgetSeatAdjustUntil: Date | null
  currency: 'eur' | 'chf'
  interval: 'month' | 'year'
  createdAt: Date
  updatedAt: Date
}

/**
 * Stripe statuses during which the workspace keeps its plan. `past_due`
 * counts: Stripe is still retrying the payment (dunning, ~14 days), and
 * the admins see a banner meanwhile. `unpaid`, `canceled`, `incomplete*`
 * and `paused` do not.
 */
export const ENTITLED_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const

/** Whether a subscription row currently grants its plan. */
export function subscriptionGrantsPlan(
  row: Pick<WorkspaceSubscriptionRow, 'status' | 'validUntil'>,
  now: Date = new Date()
): boolean {
  if (!(ENTITLED_SUBSCRIPTION_STATUSES as readonly string[]).includes(row.status)) return false
  return row.validUntil === null || row.validUntil.getTime() > now.getTime()
}

export async function getWorkspaceSubscription(workspaceId: string): Promise<WorkspaceSubscriptionRow | null> {
  const db = useDatabase()
  const row = (await db
    .select()
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, workspaceId))
    .limit(1))[0]
  return row ?? null
}

export type WorkspaceSubscriptionUpsert = Omit<WorkspaceSubscriptionRow, 'createdAt' | 'updatedAt' | 'budgetSeatAdjust' | 'budgetSeatAdjustUntil'>

/** Insert or replace a workspace's subscription (Stripe webhook). */
export async function upsertWorkspaceSubscription(input: WorkspaceSubscriptionUpsert): Promise<void> {
  const db = useDatabase()
  const { workspaceId, ...rest } = input
  await db
    .insert(workspaceSubscriptions)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: workspaceSubscriptions.workspaceId,
      set: { ...rest, updatedAt: new Date() }
    })
}

/**
 * Subscriptions a user manages as billing admin — for their data export
 * and the account-deletion hand-over (WP3). Ids and plan facts only.
 */
export async function listSubscriptionsByBillingAdmin(userId: number): Promise<Array<Pick<WorkspaceSubscriptionRow, 'workspaceId' | 'plan' | 'seats' | 'status' | 'validUntil' | 'currency' | 'interval' | 'createdAt'>>> {
  const db = useDatabase()
  return db
    .select({
      workspaceId: workspaceSubscriptions.workspaceId,
      plan: workspaceSubscriptions.plan,
      seats: workspaceSubscriptions.seats,
      status: workspaceSubscriptions.status,
      validUntil: workspaceSubscriptions.validUntil,
      currency: workspaceSubscriptions.currency,
      interval: workspaceSubscriptions.interval,
      createdAt: workspaceSubscriptions.createdAt
    })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.billingAdminId, userId))
}

/** Subscriptions of every workspace the user is a member of ("workspaces that cover you"). */
export async function listSubscribedWorkspacesForMember(userId: number): Promise<Array<{ workspaceId: string, plan: WorkspacePlanName, status: string, validUntil: Date | null }>> {
  const db = useDatabase()
  return db
    .select({
      workspaceId: workspaceSubscriptions.workspaceId,
      plan: workspaceSubscriptions.plan,
      status: workspaceSubscriptions.status,
      validUntil: workspaceSubscriptions.validUntil
    })
    .from(workspaceSubscriptions)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaceSubscriptions.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
}

/**
 * SQL subquery: ids of workspaces whose subscription currently grants
 * its plan (same rule as `subscriptionGrantsPlan`). Storage inside them
 * is pooled per workspace, so per-user storage sums leave them out
 * (only while billing is on — the caller decides).
 */
export function pooledWorkspaceIdsSubquery(): SQL {
  return sql`(select ${workspaceSubscriptions.workspaceId} from ${workspaceSubscriptions}
    where ${workspaceSubscriptions.status} in ('active', 'trialing', 'past_due')
      and (${workspaceSubscriptions.validUntil} is null or ${workspaceSubscriptions.validUntil} > now()))`
}

/** Subscription rows of several workspaces (badges, hints). */
export async function listSubscriptionsForWorkspaces(workspaceIds: readonly string[]): Promise<WorkspaceSubscriptionRow[]> {
  if (workspaceIds.length === 0) return []
  return useDatabase().select().from(workspaceSubscriptions).where(inArray(workspaceSubscriptions.workspaceId, [...workspaceIds])) as Promise<WorkspaceSubscriptionRow[]>
}
