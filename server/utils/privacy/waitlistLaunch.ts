import { setTimeout as sleepMs } from 'node:timers/promises'
import {
  countWaitlistSignups,
  deleteUnconfirmedWaitlistSignups,
  deleteWaitlistSignupById,
  nextConfirmedWaitlistSignups,
  type WaitlistLaunchRecipient
} from '../../repos/waitlist'
import { system } from '../../repos/proofs'
import { isBillingEnabled } from '../billing/billingMode'
import { emailDeliveryConfigured, sendTransactionalEmail, type SendEmailArgs, type SendEmailResult } from '../email/sendEmail'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import { normaliseWaitlistLocale, type WaitlistLocale } from './waitlist'
import { useEnv } from '~~/shared/env/load'
import { trimTrailingSlashes } from '~~/shared/utils/trimTrailingSlashes'

// The paid-plans launch email: the one email the waitlist consent text
// promised ("Get one email when paid plans launch. That's all we'll
// send."). Run once by the operator after billing is switched on
// (`scripts/waitlist-launch-email.ts`, bundled as cli/waitlist-launch-email.js).
//
// Each confirmed sign-up gets the email and its row is deleted right after
// the send succeeded: the purpose is fulfilled, and a rerun (after a crash
// or a failed send) mails only the rows still there, never anyone twice.
// Unconfirmed sign-ups never consented, so they are deleted unsent.
//
// Kept free of Nitro auto-imports so the CLI bundle runs standalone.

/** The share off the first year of Pro yearly the launch codes give, as stated in the email. */
export const WAITLIST_LAUNCH_DISCOUNT_PERCENT = 40

/**
 * Pause between two sends. Resend's default limit is a few requests per
 * second per team, shared with the app's own emails; this stays well under.
 */
const WAITLIST_LAUNCH_DEFAULT_INTERVAL_MS = 600

/** Consecutive failed sends after which the run stops: something is wrong with delivery, not one address. */
const MAX_CONSECUTIVE_FAILURES = 5

const PAGE_SIZE = 100

interface LaunchEmailCopy {
  subject: string
  intro: string
  offer: (args: { code: string, percent: number, date: string }) => string
  onlyEmail: string
}

const LAUNCH_EMAIL_COPY: Record<WaitlistLocale, LaunchEmailCopy> = {
  en: {
    subject: 'markoto\'s paid plans are live',
    intro: 'You asked us to tell you when markoto\'s paid plans launch. They are live now:',
    offer: ({ code, percent, date }) => `Thank you for waiting. The code ${code} takes ${percent}% off the first year of Pro with yearly billing. Choose yearly billing on the pricing page and enter the code at checkout. The code is valid until ${date}.`,
    onlyEmail: 'This is the only email we send you about the launch, as promised. Your address has now been deleted from the waitlist, so there is nothing to unsubscribe from.'
  },
  de: {
    subject: 'Die Bezahlpläne von markoto sind da',
    intro: 'Du wolltest wissen, wann die Bezahlpläne von markoto starten. Ab sofort sind sie verfügbar:',
    offer: ({ code, percent, date }) => `Danke fürs Warten. Mit dem Code ${code} erhältst du ${percent} % Rabatt auf das erste Jahr von Pro bei jährlicher Abrechnung. Wähle auf der Preisseite die jährliche Abrechnung und gib den Code beim Bezahlen ein. Der Code gilt bis zum ${date}.`,
    onlyEmail: 'Wie versprochen ist dies die einzige E-Mail, die wir dir zum Start schicken. Deine Adresse ist jetzt von der Warteliste gelöscht, du musst dich also nirgends abmelden.'
  },
  fr: {
    subject: 'Les offres payantes de markoto sont disponibles',
    intro: 'Vous aviez demandé à être prévenu du lancement des offres payantes de markoto. Elles sont disponibles dès maintenant :',
    offer: ({ code, percent, date }) => `Merci de votre patience. Le code ${code} vous offre ${percent} % de réduction sur la première année de Pro avec facturation annuelle. Choisissez la facturation annuelle sur la page des tarifs et saisissez le code lors du paiement. Le code est valable jusqu'au ${date}.`,
    onlyEmail: 'Comme promis, c\'est le seul e-mail que nous vous envoyons à propos du lancement. Votre adresse a été supprimée de la liste d\'attente, vous n\'avez donc rien à faire pour vous désinscrire.'
  },
  es: {
    subject: 'Los planes de pago de markoto ya están disponibles',
    intro: 'Pediste que te avisáramos cuando se lanzaran los planes de pago de markoto. Ya están disponibles:',
    offer: ({ code, percent, date }) => `Gracias por esperar. El código ${code} te descuenta un ${percent} % del primer año de Pro con facturación anual. Elige la facturación anual en la página de precios e introduce el código al pagar. El código es válido hasta el ${date}.`,
    onlyEmail: 'Como prometimos, este es el único correo que te enviamos sobre el lanzamiento. Hemos eliminado tu dirección de la lista de espera, así que no tienes que darte de baja de nada.'
  },
  ja: {
    subject: 'markoto の有料プランが始まりました',
    intro: 'markoto の有料プラン開始時のお知らせをご希望いただきありがとうございました。有料プランは本日からご利用いただけます:',
    offer: ({ code, percent, date }) => `お待ちいただいたお礼として、コード ${code} で年払いの Pro の初年度が ${percent}% 割引になります。料金ページで年払いを選び、お支払い時にコードを入力してください。コードの有効期限は ${date} までです。`,
    onlyEmail: 'お約束どおり、有料プランの開始についてお送りするメールはこの 1 通のみです。お客様のメールアドレスはウェイトリストから削除済みのため、配信停止の手続きは必要ありません。'
  },
  zh: {
    subject: 'markoto 付费方案现已上线',
    intro: '您曾希望在 markoto 付费方案上线时收到通知。付费方案现已上线：',
    offer: ({ code, percent, date }) => `感谢您的等待。使用优惠码 ${code}，按年付费的 Pro 方案首年可享 ${percent}% 折扣。请在价格页面选择按年付费，并在结账时输入优惠码。优惠码有效期至 ${date}。`,
    onlyEmail: '正如我们承诺的，这是关于上线的唯一一封邮件。您的邮箱地址已从候补名单中删除，因此无需退订。'
  }
}

/** `YYYY-MM-DD` as a date in the reader's language (the day itself, not shifted by a time zone). */
function formatLaunchDate(isoDay: string, locale: WaitlistLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${isoDay}T00:00:00Z`))
}

/**
 * The launch email. `baseUrl` must be the deployment's configured origin
 * (`emailLinkBaseUrl`), never a request header.
 */
export function buildWaitlistLaunchEmail(args: {
  locale: WaitlistLocale
  baseUrl: string
  code: string
  expiresOn: string
}): { subject: string, body: string } {
  const copy = LAUNCH_EMAIL_COPY[args.locale]
  const pricingUrl = `${trimTrailingSlashes(args.baseUrl)}/pricing`
  const date = formatLaunchDate(args.expiresOn, args.locale)
  const body = [
    copy.intro,
    pricingUrl,
    '',
    copy.offer({ code: args.code, percent: WAITLIST_LAUNCH_DISCOUNT_PERCENT, date }),
    '',
    copy.onlyEmail
  ].join('\n')
  return { subject: copy.subject, body }
}

export interface WaitlistLaunchOptions {
  /** The Stripe promotion code, as the buyer types it. */
  code: string
  /** Last day the code is valid, `YYYY-MM-DD`. */
  expiresOn: string
  /** Count only: no email, no deletion, never an address. */
  dryRun: boolean
  intervalMs?: number
  now?: Date
  log?: (line: string) => void
  /** Injected in tests; production sends through Resend. */
  send?: (args: SendEmailArgs) => Promise<SendEmailResult>
  deliveryConfigured?: () => boolean
  sleep?: (ms: number) => Promise<unknown>
}

export interface WaitlistLaunchSummary {
  confirmed: number
  unconfirmed: number
  sent: number
  failed: number
  deletedUnconfirmed: number
  /** True when the run stopped early after repeated failures (rerun to continue). */
  stopped: boolean
}

const CODE_PATTERN = /^[A-Za-z0-9_-]{3,64}$/
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Why the given code / expiry can't be used, or null when they can. */
export function waitlistLaunchArgsProblem(code: string, expiresOn: string, now: Date = new Date()): string | null {
  if (!CODE_PATTERN.test(code)) return '--code must be 3 to 64 letters, digits, "-" or "_"'
  if (!DAY_PATTERN.test(expiresOn) || Number.isNaN(Date.parse(`${expiresOn}T00:00:00Z`))
    || new Date(`${expiresOn}T00:00:00Z`).toISOString().slice(0, 10) !== expiresOn) {
    return '--expires must be a date as YYYY-MM-DD'
  }
  if (expiresOn < now.toISOString().slice(0, 10)) return '--expires is in the past'
  return null
}

/** The pricing page's origin, after every check that must pass before anything is read. Throws otherwise. */
function launchBaseUrl(options: WaitlistLaunchOptions): string {
  const problem = waitlistLaunchArgsProblem(options.code, options.expiresOn, options.now)
  if (problem) throw new Error(problem)
  // Before billing is on, the email would announce plans nobody can buy.
  if (!isBillingEnabled()) throw new Error('billing is off (NUXT_BILLING_ENABLED): switch paid plans on before sending the launch email')
  const baseUrl = emailLinkBaseUrl(useEnv().core.siteUrl)
  if (!baseUrl) throw new Error('NUXT_SITE_URL is not set: the email needs the link to the pricing page')
  return baseUrl
}

/** Send the launch email to every confirmed sign-up and empty the waitlist. Throws when it must not run. */
export async function runWaitlistLaunch(options: WaitlistLaunchOptions): Promise<WaitlistLaunchSummary> {
  const by = system('waitlist-launch')
  const log = options.log ?? (() => {})
  const baseUrl = launchBaseUrl(options)

  const counts = await countWaitlistSignups(by)
  const summary: WaitlistLaunchSummary = { ...counts, sent: 0, failed: 0, deletedUnconfirmed: 0, stopped: false }
  log(`${counts.confirmed} confirmed sign-up(s) to email, ${counts.unconfirmed} unconfirmed to delete without email`)
  if (options.dryRun) return summary

  // Stub mode logs instead of sending: rows would be deleted unmailed.
  if (!(options.deliveryConfigured ?? emailDeliveryConfigured)()) {
    throw new Error('email delivery is not configured (RESEND_API_KEY unset or NUXT_EMAIL_PROVIDER=stub): nothing was sent or deleted')
  }

  summary.deletedUnconfirmed = await deleteUnconfirmedWaitlistSignups(by)
  await mailConfirmedSignups(options, baseUrl, summary, log)
  return summary
}

interface LaunchSender {
  options: WaitlistLaunchOptions
  baseUrl: string
  send: NonNullable<WaitlistLaunchOptions['send']>
  sleep: NonNullable<WaitlistLaunchOptions['sleep']>
  intervalMs: number
}

/** Mail and delete the confirmed rows page by page; a failed row stays for the next run. Updates `summary`. */
async function mailConfirmedSignups(options: WaitlistLaunchOptions, baseUrl: string, summary: WaitlistLaunchSummary, log: (line: string) => void): Promise<void> {
  const by = system('waitlist-launch')
  const sender: LaunchSender = {
    options,
    baseUrl,
    send: options.send ?? sendTransactionalEmail,
    sleep: options.sleep ?? sleepMs,
    intervalMs: options.intervalMs ?? WAITLIST_LAUNCH_DEFAULT_INTERVAL_MS
  }
  let cursor = 0
  let consecutiveFailures = 0
  for (;;) {
    const page = await nextConfirmedWaitlistSignups(by, cursor, PAGE_SIZE)
    if (page.length === 0) return
    for (const row of page) {
      cursor = row.id
      consecutiveFailures = (await mailAndDelete(sender, row, summary)) ? 0 : consecutiveFailures + 1
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        summary.stopped = true
        log(`stopped after ${consecutiveFailures} failed sends in a row; fix delivery and run again`)
        return
      }
      if (summary.sent + summary.failed < summary.confirmed) await sender.sleep(sender.intervalMs)
    }
    log(`${summary.sent} sent, ${summary.failed} failed so far`)
  }
}

/** One sign-up: the email, then (only once it went out) the row's deletion. Returns whether it was sent. */
async function mailAndDelete(sender: LaunchSender, row: WaitlistLaunchRecipient, summary: WaitlistLaunchSummary): Promise<boolean> {
  const locale = normaliseWaitlistLocale(row.locale)
  const content = buildWaitlistLaunchEmail({ locale, baseUrl: sender.baseUrl, code: sender.options.code, expiresOn: sender.options.expiresOn })
  const args: SendEmailArgs = { kind: 'waitlist.launch', to: row.email, locale, subject: content.subject, body: content.body }
  if (!(await sendWithOneRetry(sender.send, args, sender.sleep, sender.intervalMs))) {
    summary.failed++
    return false
  }
  await deleteWaitlistSignupById(system('waitlist-launch'), row.id)
  summary.sent++
  return true
}

async function sendWithOneRetry(
  send: NonNullable<WaitlistLaunchOptions['send']>,
  args: SendEmailArgs,
  sleep: NonNullable<WaitlistLaunchOptions['sleep']>,
  intervalMs: number
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await send(args)
      if (result.delivered) return true
    } catch {
      // A rate limit or a transient provider error: wait and try once more.
      // The address is never logged.
    }
    if (attempt === 0) await sleep(Math.max(2000, intervalMs * 4))
  }
  return false
}
