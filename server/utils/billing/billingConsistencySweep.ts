import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { useEnv } from '~~/shared/env/load'
import { safeSendTransactionalEmail } from '../email/sendEmail'
import { useLogger } from '../platform/logger'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import { useStripeClient } from './stripeClient'
import { checkBillingConsistency, type BillingConsistencyReport, type BillingMismatch } from './billingConsistency'

const log = useLogger('billing-consistency-check')

// The daily `billing-consistency-check` (billing on): compare Stripe with
// markoto (`billingConsistency.ts`) and report drift. Every mismatch is
// logged (ids only), the run is reported to Sentry when there is any, and
// `NUXT_BILLING_NOTIFY_EMAIL` gets a plain-text summary when set.

/** Mismatches listed in the email; the admin page shows all of them. */
const EMAIL_LIST_LIMIT = 50

function line(m: BillingMismatch): string {
  const subject = m.subject ? `${m.subject.type} ${m.subject.id}` : 'no subject'
  return `- ${m.kind}: ${m.subscriptionId} (${subject}), Stripe ${m.stripe ?? '-'}, markoto ${m.markoto ?? '-'}`
}

export function buildConsistencyEmail(report: BillingConsistencyReport, siteUrl: string | null): { subject: string, body: string } {
  const n = report.mismatches.length
  const shown = report.mismatches.slice(0, EMAIL_LIST_LIMIT).map(line)
  const more = n > EMAIL_LIST_LIMIT ? [`... and ${n - EMAIL_LIST_LIMIT} more`] : []
  const page = siteUrl ? [`All of them: ${siteUrl}/admin/billing-consistency`] : []
  return {
    subject: `markoto billing check: ${n} mismatch${n === 1 ? '' : 'es'} between Stripe and markoto`,
    body: [
      `The daily billing check found ${n} mismatch${n === 1 ? '' : 'es'} (${report.checkedAt}).`,
      `Live in Stripe: ${report.stripeLive}. Tracked by markoto: ${report.trackedLive.users} personal, ${report.trackedLive.workspaces} workspace.`,
      '',
      ...shown,
      ...more,
      '',
      ...page,
      'Nothing was changed. Fix the subscription in Stripe or the row in markoto by hand.'
    ].join('\n')
  }
}

export async function runBillingConsistencyCheck(stripe: Stripe | null = useStripeClient()): Promise<{ stripeLive: number, mismatches: number }> {
  if (!stripe) return { stripeLive: 0, mismatches: 0 }
  const report = await checkBillingConsistency(stripe)
  const summary = { stripeLive: report.stripeLive, mismatches: report.mismatches.length }
  if (report.mismatches.length === 0) return summary

  for (const m of report.mismatches) {
    log.warn('billing mismatch', { kind: m.kind, subscriptionId: m.subscriptionId, subjectType: m.subject?.type ?? null, subjectId: m.subject?.id ?? null, stripe: m.stripe, markoto: m.markoto })
  }
  Sentry.captureMessage('billing consistency check found mismatches', {
    level: 'warning',
    tags: { component: 'billing', event: 'billing_consistency_mismatch' },
    extra: { count: report.mismatches.length, kinds: [...new Set(report.mismatches.map(m => m.kind))] }
  })
  const env = useEnv()
  const to = env.billing.billingNotifyEmail ?? null
  if (to) {
    const { subject, body } = buildConsistencyEmail(report, emailLinkBaseUrl(env.core.siteUrl))
    await safeSendTransactionalEmail({ kind: 'billing.consistency_report', to, locale: null, subject, body, metadata: { mismatches: report.mismatches.length } })
  }
  return summary
}
