import * as Sentry from '@sentry/nuxt'
import { Resend } from 'resend'

// Transactional email helper.
//
// **Provider auto-detection.** Setting `RESEND_API_KEY` is enough to
// switch from stub mode to real Resend delivery — we don't require
// a separate `NUXT_EMAIL_PROVIDER` flag. This matches Resend's own
// SDK convention (it reads `RESEND_API_KEY` by default) and means
// turning email on is a single env-var change. To explicitly run
// in stub mode despite a key being present, set
// `NUXT_EMAIL_PROVIDER=stub`.
//
// **Stub mode** (no key set, or `NUXT_EMAIL_PROVIDER=stub`) logs the
// email payload to the server console and returns success. The
// product's UX gates (deletion grace banner, export polling) are
// load-bearing on their own — never depend on a sent email for an
// access-control or correctness invariant.
//
// **From address** (`NUXT_EMAIL_FROM`) defaults to Resend's universal
// sandbox sender `onboarding@resend.dev`, which delivers ONLY to the
// account-owner's verified email — fine for local testing without
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

export interface SendEmailArgs {
  // What kind of email this is. Used for logging and per-kind
  // throttling decisions.
  kind: TransactionalEmailKind
  // Recipient. May be null when the user has no email on file (anonymous
  // OAuth flows can produce users without an email when the provider
  // omits it). In that case we no-op with a debug log — the in-product
  // UX is the primary surface.
  to: string | null
  // Recipient locale, falling back to 'en' when the user has not picked
  // one. Drives subject + body string lookup.
  locale: string | null
  // Subject line. Already localised at the call site (we don't do
  // template lookup here so this helper stays free of i18n machinery).
  subject: string
  // Plain-text body. We don't ship HTML emails today — text/plain
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
  // (we don't surface this to callers — it's purely for telemetry).
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
  'waitlist.confirm': 'waitlist-confirm'
}

// Resend's universal sandbox sender. Delivers only to the email
// of the Resend account owner (their TOS — anti-abuse). Fine for
// local development against a single test account; replace with a
// verified-domain address (`NUXT_EMAIL_FROM=...`) before launch.
const SANDBOX_FROM = 'markoto <onboarding@resend.dev>'

export async function sendTransactionalEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const explicitProvider = (process.env.NUXT_EMAIL_PROVIDER || '').trim().toLowerCase()
  const apiKey = process.env.RESEND_API_KEY
  const label = NORMALISED_KIND_LABELS[args.kind]

  if (!args.to) {
    console.log(`[email] no-recipient skip (kind=${label})`)
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
    console.log(`[email-stub] kind=${label} to=${redactEmail(args.to)} locale=${args.locale ?? 'en'} subject=${JSON.stringify(args.subject)} body=${JSON.stringify(previewBody)}`)
    return { delivered: true }
  }

  // Resend (auto-detected via RESEND_API_KEY). To explicitly opt
  // OUT of Resend despite the key being set, use NUXT_EMAIL_PROVIDER=stub.
  if (!explicitProvider || explicitProvider === 'resend') {
    return sendViaResend(args, label, apiKey)
  }

  console.warn(`[email] provider=${explicitProvider} requested but no dispatch branch implemented; falling back to stub`)
  return { delivered: false }
}

// Resend dispatch via the official SDK. The SDK is ~12 KB and gives
// us typed response shapes + retry primitives — worth the dep over
// hand-rolled fetch.
//
// `from` falls back to Resend's `onboarding@resend.dev` sandbox
// sender so a fresh setup with just `RESEND_API_KEY` works end-to-
// end. Production should set `NUXT_EMAIL_FROM` to a verified-domain
// address; a misconfigured `from` returns a 422 from Resend which
// we surface in the thrown error.
async function sendViaResend(args: SendEmailArgs, label: string, apiKey: string): Promise<SendEmailResult> {
  const from = process.env.NUXT_EMAIL_FROM || SANDBOX_FROM
  if (!process.env.NUXT_EMAIL_FROM) {
    // Soft warn — devs running with just the API key see the
    // sandbox limitation in their server logs. In prod, the
    // boot-time env validator should require NUXT_EMAIL_FROM
    // (added separately when we wire the prod compose).
    console.warn(`[email] NUXT_EMAIL_FROM not set; using Resend sandbox sender ${SANDBOX_FROM}. This delivers only to the Resend account owner.`)
  }

  const resend = new Resend(apiKey)
  const { data, error } = await resend.emails.send({
    from,
    // Non-null asserted: the no-recipient branch returns earlier.
    to: args.to!,
    subject: args.subject,
    text: args.body,
    // Resend tags: surface email kind in their dashboard so ops
    // can filter "all account.delete_executed bounces in the last
    // 30 days" without guessing from subjects. Tag values must
    // match `^[a-zA-Z0-9_-]+$` — `label` is already in this shape
    // (see NORMALISED_KIND_LABELS).
    tags: [{ name: 'kind', value: label }]
  })

  if (error) {
    throw new Error(`resend send failed: ${error.name}: ${error.message}`)
  }

  return { delivered: true, providerMessageId: data?.id }
}

/**
 * Show only the first character + the domain in logs. Logs frequently
 * end up in retention systems we don't fully control (Sentry, Loki,
 * archival storage) — never log full email addresses.
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
    console.error(`[email] send failed kind=${args.kind}:`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'email', emailKind: args.kind }
    })
    return null
  }
}
