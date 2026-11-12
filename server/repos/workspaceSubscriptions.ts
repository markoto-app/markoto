import { and, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { workspaceSubscriptions } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import type { WorkspacePlanName } from '../../shared/config/tiers'
import type { StripeSubscriptionStatus } from '../../shared/contracts/stripe'

// Team / Business subscriptions of workspaces. Stripe writes every row through
// the webhook; the rest of the app only reads them, through
// `resolveWorkspacePlan` (server/utils/billing/entitlements.ts).

export interface WorkspaceSubscriptionRow {
  workspaceId: string
  plan: WorkspacePlanName
  seats: number
  status: StripeSubscriptionStatus
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
const ENTITLED_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const

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

/**
 * Subscriptions a user manages as billing admin — for their data export
 * and the account-deletion hand-over. Ids and plan facts only.
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
  return useDatabase().select().from(workspaceSubscriptions).where(inArray(workspaceSubscriptions.workspaceId, [...workspaceIds]))
}

type Db = ReturnType<typeof useDatabase>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type DbOrTx = Db | Tx

// Writes of the Stripe webhook (inside its per-event transaction).

/** The workspace whose subscription uses this Stripe customer (each workspace has its own). */
export async function findWorkspaceIdByStripeCustomer(customerId: string, db: DbOrTx): Promise<string | null> {
  const ws = await db.select({ workspaceId: workspaceSubscriptions.workspaceId })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.stripeCustomerId, customerId))
    .limit(1)
  return ws[0]?.workspaceId ?? null
}

/** The workspace's subscription row, read through the caller's transaction. */
export async function getWorkspaceSubscriptionIn(db: DbOrTx, workspaceId: string): Promise<WorkspaceSubscriptionRow | null> {
  const row: WorkspaceSubscriptionRow | undefined = (await db.select().from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, workspaceId)).limit(1))[0]
  return row ?? null
}

/** Which subscription the workspace's row holds, and its status. */
export async function getWorkspaceSubscriptionState(db: DbOrTx, workspaceId: string): Promise<{ id: string | null, status: StripeSubscriptionStatus } | null> {
  const row = (await db.select({ id: workspaceSubscriptions.stripeSubscriptionId, status: workspaceSubscriptions.status })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, workspaceId)).limit(1))[0]
  return row ?? null
}

/** The subscription state Stripe reports for a workspace (`billingAdminId` only when known). */
export interface WorkspaceSubscriptionFromStripe {
  plan: WorkspacePlanName
  seats: number
  status: StripeSubscriptionStatus
  stripeCustomerId: string
  stripeSubscriptionId: string
  currentPeriodStart: Date | null
  validUntil: Date | null
  currency: 'eur' | 'chf'
  interval: 'month' | 'year'
  updatedAt: Date
}

/** Insert on first sight, update after. */
export async function upsertWorkspaceSubscription(
  db: DbOrTx,
  workspaceId: string,
  values: WorkspaceSubscriptionFromStripe,
  billingAdmin: { billingAdminId?: number | null }
): Promise<void> {
  await db.insert(workspaceSubscriptions)
    .values({ workspaceId, ...values, ...billingAdmin })
    .onConflictDoUpdate({ target: workspaceSubscriptions.workspaceId, set: { ...values, ...billingAdmin } })
}

/** The subscription ended: the row stays as the record, `resolveWorkspacePlan` stops granting the plan. Returns the rows matched. */
export async function markWorkspaceSubscriptionCanceled(db: DbOrTx, workspaceId: string): Promise<number> {
  const result = await db.update(workspaceSubscriptions)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(eq(workspaceSubscriptions.workspaceId, workspaceId))
    .returning({ workspaceId: workspaceSubscriptions.workspaceId })
  return result.length
}

/** Move the workspace's period anchors forward to `period` (never back). Returns the rows matched. */
export async function advanceWorkspaceBillingPeriod(db: DbOrTx, workspaceId: string, period: { start: Date, end: Date }): Promise<number> {
  const result = await db.update(workspaceSubscriptions)
    .set({ currentPeriodStart: period.start, validUntil: period.end, updatedAt: new Date() })
    .where(and(
      eq(workspaceSubscriptions.workspaceId, workspaceId),
      or(isNull(workspaceSubscriptions.validUntil), lt(workspaceSubscriptions.validUntil, period.end))
    ))
    .returning({ workspaceId: workspaceSubscriptions.workspaceId })
  return result.length
}
