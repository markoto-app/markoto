import * as Sentry from '@sentry/nuxt'
import { Resend } from 'resend'
import { useEnv } from '~~/shared/env/load'
import { isProduction } from '~~/shared/env/runtime'
import { useLogger } from '../platform/logger'

const log = useLogger('email')

// Transactional email helper.
//
// **Provider auto-detection.** Setting `RESEND_API_KEY` is enough to
// switch from stub mode to real Resend delivery, we don't require
// a separate `NUXT_EMAIL_PROVIDER` flag. This matches Resend's own
// SDK convention (it reads `RESEND_API_KEY` by default) and means
// turning email on is a single env-var change. To explicitly run
// in stub mode despite a key being present, set
// `NUXT_EMAIL_PROVIDER=stub`.
//
// **Stub mode** (no key set, or `NUXT_EMAIL_PROVIDER=stub`) logs the
// email payload to the server console and returns success. The
// product's UX gates (deletion grace banner, export polling) are
// load-bearing on their own, never depend on a sent email for an
// access-control or correctness invariant.
//
// **From address** (`NUXT_EMAIL_FROM`) defaults to Resend's universal
// sandbox sender `onboarding@resend.dev`, which delivers ONLY to the
// account-owner's verified email: fine for local testing without
// DNS setup. For production, set `NUXT_EMAIL_FROM` to a verified
// `<noreply@your-domain>` address (SPF + DKIM DNS records configured
// in the Resend dashboard).
//
// Failure-handling contract: this function NEVER throws via the
// `safeSendTransactionalEmail` wrapper. Failures inside the
// underlying `sendTransactionalEmail` ARE thrown so tests can
// assert error paths; the wrapper is what call sites should use.

export type TransactionalEmailKind
  = | 'account.delete_requested'
    | 'account.delete_cancelled'
    | 'account.delete_executed'
    | 'data_export.ready'
    | 'consent.version_bump'
    | 'breach.notification'
    | 'waitlist.confirm'
    | 'waitlist.launch'
    | 'workspace.invite'
    | 'workspace.billing'
    | 'billing.refund_notice'
    | 'billing.consistency_report'
    | 'abuse.operator_notice'
    | 'abuse.report_received'
    | 'abuse.decision'
    | 'moderation.statement_of_reasons'

export interface SendEmailArgs {
  // What kind of email this is. Used for logging and per-kind
  // throttling decisions.
  kind: TransactionalEmailKind
  // Recipient. May be null when the user has no email on file (anonymous
  // OAuth flows can produce users without an email when the provider
  // omits it). In that case we no-op with a debug log, the in-product
  // UX is the primary surface.
  to: string | null
  // Recipient locale, falling back to 'en' when the user has not picked
  // one. Drives subject + body string lookup.
  locale: string | null
  // Subject line. Already localised at the call site (we don't do
  // template lookup here so this helper stays free of i18n machinery).
  subject: string
  // Plain-text body. We don't ship HTML emails today, text/plain
  // surfaces correctly in every client and avoids opening up an
  // email-rendering pipeline (XSS surface, image-blocking heuristics).
  body: string
  // Optional per-message metadata recorded in logs / Sentry breadcrumbs.
  // NEVER include secrets, full-page URLs with tokens, or anything else
  // we wouldn't want in our log retention.
  metadata?: Record<string, string | number | boolean>
  // True when the body carries single-use secrets (confirm /
  // unsubscribe links). Stub mode then logs a placeholder instead of
  // the body preview, so tokens never land in log retention.
  bodyContainsSecrets?: boolean
}

export interface SendEmailResult {
  // True if the helper accepted the message (either delivered to a
  // provider or logged in stub mode). False on hard provider error
  // (we don't surface this to callers, it's purely for telemetry).
  delivered: boolean
  // Provider message id, if the dispatch branch returned one.
  providerMessageId?: string
}

const NORMALISED_KIND_LABELS: Record<TransactionalEmailKind, string> = {
  'account.delete_requested': 'account-delete-requested',
  'account.delete_cancelled': 'account-delete-cancelled',
  'account.delete_executed': 'account-delete-executed',
  'data_export.ready': 'data-export-ready',
  'consent.version_bump': 'consent-version-bump',
  'breach.notification': 'breach-notification',
  'waitlist.confirm': 'waitlist-confirm',
  'waitlist.launch': 'waitlist-launch',
  'workspace.invite': 'workspace-invite',
  'workspace.billing': 'workspace-billing',
  'billing.refund_notice': 'billing-refund-notice',
  'billing.consistency_report': 'billing-consistency-report',
  'abuse.operator_notice': 'abuse-operator-notice',
  'abuse.report_received': 'abuse-report-received',
  'abuse.decision': 'abuse-decision',
  'moderation.statement_of_reasons': 'moderation-statement-of-reasons'
}

// Resend's universal sandbox sender. Delivers only to the email
// of the Resend account owner (their TOS, anti-abuse). Fine for
// local development against a single test account; replace with a
// verified-domain address (`NUXT_EMAIL_FROM=...`) before launch.
const SANDBOX_FROM = 'markoto <onboarding@resend.dev>'

/**
 * Whether emails really go out (Resend with a key), as opposed to stub
 * mode, which only logs them. One-shot senders that delete what they
 * mailed refuse to run without it.
 */
export function emailDeliveryConfigured(): boolean {
  const { email } = useEnv()
  return Boolean(email.resendApiKey) && email.provider !== 'stub'
}

export async function sendTransactionalEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const { email } = useEnv()
  const explicitProvider = email.provider
  const apiKey = email.resendApiKey
  const label = NORMALISED_KIND_LABELS[args.kind]

  if (!args.to) {
    log.info('no recipient, skipped', { kind: label })
    return { delivered: false }
  }

  // Stub mode = no Resend key OR explicit `NUXT_EMAIL_PROVIDER=stub`.
  // Log + succeed; the product UX is load-bearing without delivery.
  const stubMode = !apiKey || explicitProvider === 'stub'
  if (stubMode) {
    let previewBody = args.body.length > 280
      ? `${args.body.slice(0, 280)}…`
      : args.body
    if (args.bodyContainsSecrets) previewBody = '<redacted: contains single-use links>'
    // Subject and body (workspace and document names, member names) are only
    // shown outside production, where the stub is how a developer reads the mail.
    const preview = isProduction() ? {} : { subject: args.subject, bodyPreview: previewBody }
    log.info('email stubbed, not sent', { kind: label, to: redactEmail(args.to), locale: args.locale ?? 'en', ...preview })
    return { delivered: true }
  }

  // Resend (auto-detected via RESEND_API_KEY). To explicitly opt
  // OUT of Resend despite the key being set, use NUXT_EMAIL_PROVIDER=stub.
  return sendViaResend({ ...args, to: args.to }, label, apiKey, email.from)
}

// Resend dispatch via the official SDK. The SDK is ~12 KB and gives
// us typed response shapes + retry primitives, worth the dep over
// hand-rolled fetch.
//
// `from` falls back to Resend's `onboarding@resend.dev` sandbox
// sender so a fresh setup with just `RESEND_API_KEY` works end-to-
// end. Production should set `NUXT_EMAIL_FROM` to a verified-domain
// address; a misconfigured `from` returns a 422 from Resend which
// we surface in the thrown error.
async function sendViaResend(args: SendEmailArgs & { to: string }, label: string, apiKey: string, configuredFrom: string | undefined): Promise<SendEmailResult> {
  const from = configuredFrom || SANDBOX_FROM
  if (!configuredFrom) {
    // Soft warn so devs running with just the API key see the
    // sandbox limitation in their server logs.
    log.warn('NUXT_EMAIL_FROM not set; using the Resend sandbox sender, which delivers only to the Resend account owner', { sender: SANDBOX_FROM })
  }

  const resend = new Resend(apiKey)
  const { data, error } = await resend.emails.send({
    from,
    to: args.to,
    subject: args.subject,
    text: args.body,
    // Resend tags: surface email kind in their dashboard so ops
    // can filter "all account.delete_executed bounces in the last
    // 30 days" without guessing from subjects. Tag values must
    // match `^[a-zA-Z0-9_-]+$`: `label` is already in this shape
    // (see NORMALISED_KIND_LABELS).
    tags: [{ name: 'kind', value: label }]
  })

  if (error) {
    throw new Error(`resend send failed: ${error.name}: ${error.message}`)
  }

  // One line per accepted message, so delivery can be followed up in the
  // provider's dashboard by id. Never the full address, subject or body.
  log.info('email sent', { kind: label, to: redactEmail(args.to), providerMessageId: data?.id ?? null })
  return { delivered: true, providerMessageId: data?.id }
}

/**
 * Show only the first character + the domain in logs. Logs frequently
 * end up in retention systems we don't fully control (Sentry, Loki,
 * archival storage): never log full email addresses.
 */
function redactEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

/**
 * Wrap any sender call so a thrown / rejected provider call cannot
 * propagate into the request handler. Use this at every call site:
 *
 *   await safeSendTransactionalEmail({...})
 *
 * Returns the result if successful, `null` if it threw (caller should
 * treat null as "best-effort side-effect failed").
 */
export async function safeSendTransactionalEmail(args: SendEmailArgs): Promise<SendEmailResult | null> {
  try {
    return await sendTransactionalEmail(args)
  } catch (e) {
    log.error('send failed', { kind: args.kind, err: e })
    Sentry.captureException(e, {
      tags: { component: 'email', emailKind: args.kind }
    })
    return null
  }
}
