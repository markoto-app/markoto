import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { eq } from 'drizzle-orm'
import { workspaceSubscriptions } from '../db/schema'
import { useDatabase } from './database'
import { findLiveSubscription } from './stripePlanChange'
import type { WorkspaceSubscriptionRow } from '../repos/workspaceSubscriptions'
import type { BillingInterval, Currency } from '~~/shared/config/pricing'
import type { WorkspacePlanName } from '~~/shared/config/tiers'

// Stripe side of Team / Business workspace subscriptions (WP3).
//
// Each workspace gets its OWN Stripe customer (metadata `workspace_id`),
// never the billing admin's personal one: invoices name the workspace,
// a personal Pro and a Team subscription never share a customer, and the
// webhook routes events by customer (`stripeWebhook.ts#subjectForCustomer`).
// The customer id is stored on a `workspace_subscriptions` row with
// status `incomplete` BEFORE the Checkout Session exists, so a
// `customer.subscription.*` event that beats `checkout.session.completed`
// already finds its workspace (and `incomplete` grants nothing).

/** Stripe answers `resource_missing` for a deleted / unknown object. */
function isMissing(e: unknown): boolean {
  return (e as { code?: string })?.code === 'resource_missing'
}

/**
 * The workspace's Stripe customer, created on first checkout, plus the
 * `incomplete` placeholder row. Never touches an existing row's plan /
 * seats / status (an entitled subscription is changed, not re-bought).
 */
export async function ensureWorkspaceCustomer(stripe: Stripe, args: {
  workspaceId: string
  workspaceName: string
  billingAdminId: number
  billingAdminEmail: string | null
  plan: WorkspacePlanName
  seats: number
  currency: Currency
  interval: BillingInterval
  existing: WorkspaceSubscriptionRow | null
}): Promise<string> {
  const db = useDatabase()
  if (args.existing?.stripeCustomerId) {
    await db.update(workspaceSubscriptions)
      .set({ billingAdminId: args.billingAdminId, updatedAt: new Date() })
      .where(eq(workspaceSubscriptions.workspaceId, args.workspaceId))
    return args.existing.stripeCustomerId
  }
  const customer = await stripe.customers.create({
    name: args.workspaceName || undefined,
    ...(args.billingAdminEmail ? { email: args.billingAdminEmail } : {}),
    metadata: { workspace_id: args.workspaceId, subject_type: 'workspace' }
  })
  await db.insert(workspaceSubscriptions).values({
    workspaceId: args.workspaceId,
    plan: args.plan,
    seats: args.seats,
    status: 'incomplete',
    billingAdminId: args.billingAdminId,
    stripeCustomerId: customer.id,
    currency: args.currency,
    interval: args.interval
  }).onConflictDoUpdate({
    target: workspaceSubscriptions.workspaceId,
    set: { stripeCustomerId: customer.id, billingAdminId: args.billingAdminId, updatedAt: new Date() }
  })
  return customer.id
}

/**
 * Change the paid seats of a live subscription (prorated). The local row
 * is updated right away so an invite that adds a seat can go through;
 * the `customer.subscription.updated` webhook writes the same value.
 */
export async function changeWorkspaceSeats(stripe: Stripe, row: WorkspaceSubscriptionRow, seats: number): Promise<void> {
  const sub = await findLiveSubscription(stripe, row.stripeSubscriptionId)
  const item = sub?.items.data[0]
  if (!sub || !item) {
    throw createError({
      statusCode: 409,
      message: 'This workspace has no active subscription to change.',
      data: { code: 'billing/no-subscription' }
    })
  }
  await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, quantity: seats }],
    proration_behavior: 'create_prorations'
  })
  await useDatabase().update(workspaceSubscriptions)
    .set({ seats, updatedAt: new Date() })
    .where(eq(workspaceSubscriptions.workspaceId, row.workspaceId))
}

/**
 * Cancel a workspace's subscription now (the workspace is being
 * deleted). Annual plans get a prorated credit on the customer
 * (`prorate: true`; refunds to the card stay a manual Stripe action).
 * Best-effort: a Stripe failure is logged, never blocks the deletion.
 */
export async function cancelWorkspaceSubscriptionNow(stripe: Stripe | null, row: WorkspaceSubscriptionRow | null): Promise<void> {
  if (!stripe || !row?.stripeSubscriptionId) return
  try {
    await stripe.subscriptions.cancel(row.stripeSubscriptionId, { prorate: row.interval === 'year', invoice_now: false })
  } catch (e) {
    if (isMissing(e)) return
    console.error('[workspaceStripe] cancel on workspace delete failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_cancel_failed', workspaceId: row.workspaceId } })
  }
}

/**
 * The subscription has no billing admin left (their account is gone and
 * no other admin could take over): stop renewing; it ends at the period
 * end. Best-effort.
 */
export async function cancelWorkspaceSubscriptionAtPeriodEnd(stripe: Stripe | null, row: WorkspaceSubscriptionRow): Promise<void> {
  if (!stripe || !row.stripeSubscriptionId) return
  try {
    await stripe.subscriptions.update(row.stripeSubscriptionId, { cancel_at_period_end: true })
  } catch (e) {
    if (isMissing(e)) return
    console.error('[workspaceStripe] cancel at period end failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_cancel_period_end_failed', workspaceId: row.workspaceId } })
  }
}

/** Request origin for Stripe return URLs (Origin, else Host — both survive Traefik). */
export function requestBaseUrl(event: Parameters<typeof getRequestHeader>[0]): string {
  const origin = getRequestHeader(event, 'origin') ?? getRequestHeader(event, 'host') ?? ''
  return origin.startsWith('http') ? origin : `https://${origin}`
}
