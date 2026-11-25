import type Stripe from 'stripe'

// Ending every live subscription of the STAGING Stripe sandbox, run by the
// staging database reset (`scripts/reset-staging-db.sh` -> the bundled
// `cli/cancel-sandbox-subscriptions.js`). Wiping staging's database drops
// the rows that track these subscriptions, so without this the sandbox
// keeps billing customers staging no longer knows (and the next consistency
// check reports them all). Keep it free of Nitro auto-imports: it is
// bundled into a standalone CLI.

/** The subscription states that still bill (or are about to). */
export const BILLING_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const

/**
 * Metadata key the billing-sandbox test suite puts on what it creates.
 * Its subscriptions belong to a CI run that may share the sandbox and
 * cleans up after itself, so the reset leaves them alone.
 */
export const TEST_RUN_METADATA_KEY = 'markoto_test_run'

export type SandboxKeyCheck = { ok: true } | { ok: false, reason: 'missing' | 'live' | 'unrecognised' }

/**
 * Only a test-mode key may run this. A live key (`sk_live_`, `rk_live_`)
 * is refused outright, and so is anything that is not visibly a test key:
 * cancelling every subscription of a live account would end real plans.
 */
export function checkSandboxKey(key: string | null | undefined): SandboxKeyCheck {
  const k = (key ?? '').trim()
  if (!k) return { ok: false, reason: 'missing' }
  if (/^(?:sk|rk)_live_/.test(k)) return { ok: false, reason: 'live' }
  if (!/^(?:sk|rk)_test_/.test(k)) return { ok: false, reason: 'unrecognised' }
  return { ok: true }
}

export interface SandboxCancelSummary {
  /** Live subscriptions seen. */
  seen: number
  cancelled: number
  /** Already ended by the time the cancel arrived (another run, a webhook). */
  alreadyEnded: number
  /** Left alone: the CI test suite's own, or (never expected) a live-mode object. */
  skipped: number
}

function isSuiteSubscription(sub: Stripe.Subscription): boolean {
  return Boolean(sub.metadata?.[TEST_RUN_METADATA_KEY]) || Boolean(sub.test_clock)
}

/**
 * Cancel every active, trialing or past-due subscription of the sandbox
 * at once: no proration and no refund (a refund mails the operator).
 * Idempotent: a second run finds nothing left to cancel.
 */
export async function cancelSandboxSubscriptions(stripe: Stripe): Promise<SandboxCancelSummary> {
  const summary: SandboxCancelSummary = { seen: 0, cancelled: 0, alreadyEnded: 0, skipped: 0 }
  for (const status of BILLING_SUBSCRIPTION_STATUSES) {
    // Cancelling while paging would shift the list under the cursor, so
    // each status is read in full first.
    const subs: Stripe.Subscription[] = []
    for await (const sub of stripe.subscriptions.list({ status, limit: 100 })) subs.push(sub)
    for (const sub of subs) {
      summary.seen++
      if (sub.livemode || isSuiteSubscription(sub)) {
        summary.skipped++
        continue
      }
      try {
        await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false })
        summary.cancelled++
      } catch (e) {
        // Ended in the meantime: Stripe refuses to cancel twice.
        if ((e as { type?: string })?.type !== 'StripeInvalidRequestError') throw e
        summary.alreadyEnded++
      }
    }
  }
  return summary
}
