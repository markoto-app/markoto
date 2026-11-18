import { listSubscriptionEventsOfUser } from '../../repos/subscriptionEvents'
import { strToU8 } from 'fflate'
import { adConversionsForExport } from '../../repos/adConversions'
import * as Sentry from '@sentry/nuxt'
import { useStripeClient } from '../billing/stripeClient'
import { isBillingEnabled } from '../billing/billingMode'
import { listWaitlistSignupsForUser } from '../../repos/waitlist'
import { listAiProviders } from '../../repos/aiProviders'
import { listInvitesForExport } from '../../repos/workspaceInvites'
import { normaliseInviteEmail } from '../workspaces/workspaceInvites'
import { listGrants } from '../../repos/aiCreditGrants'
import { listSubscriptionsByBillingAdmin } from '../../repos/workspaceSubscriptions'
import { listPublishedPagesForOwner } from '../../repos/publishedPages'
import { listCustomDomainsForUser } from '../../repos/customDomains'
import { listImportJobsForExport } from '../../repos/imports'
import type { UserScope } from '../../repos/proofs'

// Sections of the GDPR export (`dataExport.ts`) that read through the
// repos or from Stripe: invitations, the waitlist, AI provider settings,
// workspace subscriptions, credit top-ups, published pages and custom
// domains, billing. Each writes its file(s) into the archive and returns
// its row count.

/** Archive path → file bytes. */
export type ExportEntries = Record<string, Uint8Array>

/**
 * Open workspace invitations: addressed to the user's email, and sent by
 * the user. Token hashes are never exported.
 */
export async function addWorkspaceInvitesEntry(entries: ExportEntries, user: UserScope, email: string | null): Promise<number> {
  const { received, sent } = await listInvitesForExport(user, normaliseInviteEmail(email))
  entries['workspace_invites.json'] = strToU8(JSON.stringify({
    received: received.map(r => ({
      workspaceName: r.workspaceName,
      role: r.role,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString()
    })),
    sent: sent.map(s => ({
      workspaceId: s.workspaceId,
      email: s.email,
      role: s.role,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString()
    }))
  }, null, 2))
  return received.length + sent.length
}

/**
 * Paid-plans waitlist rows linked to the account (sign-ups made while
 * signed in). Token hashes are deliberately not exported, see
 * `listWaitlistSignupsForUser`.
 */
export async function addWaitlistEntry(entries: ExportEntries, user: UserScope): Promise<number> {
  const rows = await listWaitlistSignupsForUser(user)
  entries['waitlist.ndjson'] = strToU8(toNdjson(rows))
  return rows.length
}

/** Google Ads click-id conversions recorded for the account (docs/operations-analytics.md). */
export async function addAdConversionsEntry(entries: ExportEntries, user: UserScope): Promise<number> {
  const rows = await adConversionsForExport(user)
  entries['ad_conversions.ndjson'] = strToU8(toNdjson(rows))
  return rows.length
}

/**
 * Bring-your-own-key AI provider configs. Exported WITHOUT the key,
 * neither the ciphertext nor the last four characters: an export ZIP
 * travels by email link and must not become a credential carrier.
 */
export async function addAiProvidersEntry(entries: ExportEntries, user: UserScope): Promise<number> {
  const rows = await listAiProviders(user)
  entries['ai/providers.json'] = strToU8(JSON.stringify(rows.map(r => ({
    capability: r.capability,
    baseUrl: r.baseUrl,
    model: r.model,
    fastModel: r.fastModel,
    supportsVision: r.supportsVision,
    supportsTools: r.supportsTools,
    lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  })), null, 2))
  return rows.length
}

/** Workspace subscriptions the user manages as billing admin (always written). */
export async function addWorkspaceSubscriptionsEntry(entries: ExportEntries, user: UserScope): Promise<number> {
  const rows = await listSubscriptionsByBillingAdmin(user.userId)
  entries['billing/workspace_subscriptions.json'] = strToU8(JSON.stringify(rows.map(r => ({
    workspaceId: r.workspaceId,
    plan: r.plan,
    seats: r.seats,
    status: r.status,
    validUntil: r.validUntil?.toISOString() ?? null,
    currency: r.currency,
    interval: r.interval,
    createdAt: r.createdAt.toISOString()
  })), null, 2))
  return rows.length
}

/** Personal subscription history: started, changed, cancelled, ended (always written). */
export async function addSubscriptionHistoryEntry(entries: ExportEntries, user: UserScope): Promise<number> {
  const rows = await listSubscriptionEventsOfUser(user)
  entries['billing/subscription_history.json'] = strToU8(JSON.stringify(rows.map(r => ({
    event: r.kind,
    plan: r.plan,
    interval: r.interval,
    currency: r.currency,
    occurredAt: r.occurredAt.toISOString()
  })), null, 2))
  return rows.length
}

/** Personal AI credit top-ups (always written). */
export async function addCreditGrantsEntry(entries: ExportEntries, user: UserScope): Promise<number> {
  const rows = await listGrants({ type: 'user', id: String(user.userId) })
  entries['billing/ai_credits.json'] = strToU8(JSON.stringify(rows.map(r => ({
    pack: r.pack,
    creditUsd: r.amountUsd,
    remainingUsd: r.remainingUsd,
    refundedUsd: r.refundedUsd,
    amountPaid: r.amountPaid,
    currency: r.currency,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString()
  })), null, 2))
  return rows.length
}

/** Publishing: web pages of documents you own, your custom domains. */
export async function addPublishingEntries(entries: ExportEntries, user: UserScope): Promise<void> {
  const pages = await listPublishedPagesForOwner(user)
  entries['published_pages.json'] = strToU8(JSON.stringify(pages.map(p => ({
    docId: p.docId,
    slug: p.slug,
    title: p.title,
    indexable: p.indexable,
    publishedAt: p.publishedAt.toISOString(),
    updatedAt: p.updatedAt.toISOString()
  })), null, 2))
  const domains = await listCustomDomainsForUser(user)
  // No verification token: it's a credential for the domain check.
  entries['custom_domains.json'] = strToU8(JSON.stringify(domains.map(d => ({
    hostname: d.hostname,
    status: d.status,
    lastCheckProblem: d.lastError,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    showsDocument: d.pageDocId
  })), null, 2))
}

/**
 * Bulk imports you started: source (and the repository URL of a GitHub
 * import), outcome, and per file its path, status and the document it
 * became. File contents are never kept, so none are exported.
 */
export async function addImportJobsEntry(entries: ExportEntries, user: UserScope): Promise<number> {
  const jobs = await listImportJobsForExport(user)
  entries['imports.json'] = strToU8(JSON.stringify(jobs.map(j => ({
    jobId: j.jobId,
    workspaceId: j.workspaceId,
    source: j.source,
    repositoryUrl: j.sourceRef,
    status: j.status,
    error: j.error,
    total: j.total,
    done: j.done,
    failed: j.failed,
    skipped: j.skipped,
    totalBytes: j.totalBytes,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
    files: j.items.map(i => ({ path: i.relativePath, status: i.status, reason: i.reason, docId: i.docId }))
  })), null, 2))
  return jobs.length
}

/**
 * Stripe billing: best-effort. Failures land an error marker so the
 * user can re-request later; no Stripe customer at all emits empty
 * placeholders for layout stability. Invoices capped at 100 to
 * survive malicious / weird state without blowing the export.
 */
export async function addBillingEntries(entries: ExportEntries, stripeCustomerId: string | null): Promise<number> {
  // Billing off → no Stripe client exists on this deployment; emit the
  // same empty placeholders as "no Stripe customer" so the layout stays
  // stable and the export never fails on billing.
  if (!stripeCustomerId || !isBillingEnabled()) {
    entries['billing/customer.json'] = strToU8('{}')
    entries['billing/invoices.ndjson'] = strToU8('')
    return 0
  }
  try {
    const stripe = useStripeClient()
    if (!stripe) {
      entries['billing/customer.json'] = strToU8('{"error":"stripe client unavailable; export was built without billing data"}')
      entries['billing/invoices.ndjson'] = strToU8('')
      return 0
    }
    const customer = await stripe.customers.retrieve(stripeCustomerId)
    entries['billing/customer.json'] = strToU8(JSON.stringify(customer, null, 2))
    const list = await stripe.invoices.list({ customer: stripeCustomerId, limit: 100 })
    entries['billing/invoices.ndjson'] = strToU8(toNdjson(list.data))
    return list.data.length
  } catch (e) {
    Sentry.captureException(e, {
      tags: { component: 'dataExport', event: 'stripe_fetch_failed' }
    })
    const msg = e instanceof Error ? e.message : String(e)
    entries['billing/customer.json'] = strToU8(JSON.stringify({ error: `stripe fetch failed: ${msg}` }, null, 2))
    entries['billing/invoices.ndjson'] = strToU8('')
    return 0
  }
}

export function toNdjson(rows: readonly object[]): string {
  if (rows.length === 0) return ''
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n'
}
