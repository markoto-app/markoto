import { createHash, randomBytes } from 'node:crypto'
import { isValidEmailShape } from '../workspaces/emailShape'
import { getBillingMode } from '../billing/billingMode'
import { DAY_MS } from '~~/shared/config/units'
import { trimTrailingSlashes } from '~~/shared/utils/trimTrailingSlashes'

// Paid-plans waitlist helpers: token minting/hashing, email
// normalisation, the localised double-opt-in email, and the "is the
// waitlist open" gate. Pure where possible so `tests/unit/privacy/waitlist.test.ts`
// can pin the behaviour without a DB.

/** How long a confirm link stays valid; unconfirmed rows are reaped after this. */
export const WAITLIST_CONFIRM_TTL_MS = 7 * DAY_MS

/** RFC 5321 caps a forward-path at 254 characters. */
const WAITLIST_EMAIL_MAX_LENGTH = 254

export const WAITLIST_LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
export type WaitlistLocale = (typeof WAITLIST_LOCALES)[number]

/**
 * The waitlist only exists while billing is OFF and the deployment
 * advertises upcoming paid plans (`NUXT_PLANS_COMING_SOON`), i.e. the
 * hosted free-only SaaS. Self-hosted instances never collect sign-ups
 * for LatentSpace Labs' commercial plans, and once billing is live
 * there is nothing to wait for.
 */
export function isWaitlistOpen(): boolean {
  return getBillingMode().plansComingSoon
}

/**
 * Normalise an email for storage + uniqueness: trim + lower-case.
 * Returns null when the result isn't a plausible address or is longer
 * than RFC 5321 allows. (Lower-casing the local part is technically
 * lossy, but every mainstream provider treats it case-insensitively and
 * it's what makes re-signups idempotent.)
 */
export function normaliseWaitlistEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > WAITLIST_EMAIL_MAX_LENGTH) return null
  return isValidEmailShape(email) ? email : null
}

export function normaliseWaitlistLocale(raw: unknown): WaitlistLocale {
  return WAITLIST_LOCALES.find(l => l === raw) ?? 'en'
}

/** 256-bit URL-safe random token. Only ever sent by email, never stored raw. */
export function generateWaitlistToken(): string {
  return randomBytes(32).toString('base64url')
}

/** SHA-256 hex of a token, the only form that reaches the database. */
export function hashWaitlistToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Accept a token from a request body: a non-empty base64url string of
 * sane length. Anything else is rejected before hashing so garbage
 * input never turns into a DB lookup.
 */
export function parseWaitlistToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return /^[\w-]{20,128}$/.test(raw) ? raw : null
}

interface WaitlistEmailCopy {
  subject: string
  intro: string
  confirmLabel: string
  expiry: string
  unsubscribeLabel: string
  ignore: string
}

// Localised double-opt-in email. Plain text (sendEmail.ts doesn't ship
// HTML). Kept here rather than in i18n/locales because it renders on
// the server, outside the Vue i18n runtime.
const WAITLIST_EMAIL_COPY: Record<WaitlistLocale, WaitlistEmailCopy> = {
  en: {
    subject: 'Confirm your spot on the markoto paid-plans waitlist',
    intro: 'Someone (hopefully you) asked to be told when markoto\'s paid plans launch. We will only email you about that launch.',
    confirmLabel: 'Confirm your sign-up:',
    expiry: 'This link is valid for 7 days. If you don\'t confirm, we delete your address automatically.',
    unsubscribeLabel: 'Changed your mind? Remove your address at any time:',
    ignore: 'If you didn\'t sign up, ignore this email, nothing else will be sent.'
  },
  de: {
    subject: 'Bestätigen Sie Ihren Platz auf der Warteliste für die markoto-Bezahlpläne',
    intro: 'Jemand (hoffentlich Sie) möchte informiert werden, sobald die Bezahlpläne von markoto starten. Wir schreiben Ihnen ausschliesslich zu diesem Start.',
    confirmLabel: 'Anmeldung bestätigen:',
    expiry: 'Dieser Link ist 7 Tage gültig. Ohne Bestätigung löschen wir Ihre Adresse automatisch.',
    unsubscribeLabel: 'Meinung geändert? Hier entfernen Sie Ihre Adresse jederzeit:',
    ignore: 'Falls Sie sich nicht angemeldet haben, ignorieren Sie diese E-Mail, Sie erhalten nichts weiter.'
  },
  fr: {
    subject: 'Confirmez votre inscription à la liste d\'attente des offres payantes markoto',
    intro: 'Quelqu\'un (vous, nous l\'espérons) a demandé à être prévenu du lancement des offres payantes de markoto. Nous ne vous écrirons qu\'à ce sujet.',
    confirmLabel: 'Confirmez votre inscription :',
    expiry: 'Ce lien est valable 7 jours. Sans confirmation, nous supprimons automatiquement votre adresse.',
    unsubscribeLabel: 'Vous avez changé d\'avis ? Retirez votre adresse à tout moment :',
    ignore: 'Si vous ne vous êtes pas inscrit, ignorez cet e-mail, vous ne recevrez rien d\'autre.'
  },
  es: {
    subject: 'Confirma tu lugar en la lista de espera de los planes de pago de markoto',
    intro: 'Alguien (esperamos que tú) ha pedido recibir un aviso cuando se lancen los planes de pago de markoto. Solo te escribiremos sobre ese lanzamiento.',
    confirmLabel: 'Confirma tu inscripción:',
    expiry: 'Este enlace es válido durante 7 días. Si no lo confirmas, eliminaremos tu dirección automáticamente.',
    unsubscribeLabel: '¿Has cambiado de opinión? Elimina tu dirección en cualquier momento:',
    ignore: 'Si no te has inscrito, ignora este correo: no recibirás nada más.'
  },
  ja: {
    subject: 'markoto 有料プランのウェイトリスト登録を確認してください',
    intro: 'markoto の有料プラン開始時に通知を受け取る登録がありました。このメールアドレスには、有料プランの開始に関するお知らせのみをお送りします。',
    confirmLabel: '登録を確認する:',
    expiry: 'このリンクの有効期限は 7 日間です。確認されない場合、メールアドレスは自動的に削除されます。',
    unsubscribeLabel: '登録を取り消す場合は、いつでもこちらからメールアドレスを削除できます:',
    ignore: '心当たりがない場合は、このメールを無視してください。今後メールが届くことはありません。'
  },
  zh: {
    subject: '请确认加入 markoto 付费方案候补名单',
    intro: '有人（希望是您）申请在 markoto 付费方案上线时收到通知。我们只会就此次上线给您发送邮件。',
    confirmLabel: '确认您的登记：',
    expiry: '此链接 7 天内有效。如未确认，我们会自动删除您的邮箱地址。',
    unsubscribeLabel: '改变主意了？您可以随时在此删除您的邮箱地址：',
    ignore: '如果这不是您本人的操作，请忽略此邮件，您不会再收到任何邮件。'
  }
}

export interface WaitlistEmailContent {
  subject: string
  body: string
}

/**
 * Build the confirmation email. `baseUrl` must be the deployment's own
 * origin from configuration (NEVER the request's Origin header, that
 * would let anyone make our email point at a phishing domain).
 */
export function buildWaitlistConfirmEmail(args: {
  locale: WaitlistLocale
  baseUrl: string
  confirmToken: string
  unsubscribeToken: string
}): WaitlistEmailContent {
  const copy = WAITLIST_EMAIL_COPY[args.locale]
  const base = trimTrailingSlashes(args.baseUrl)
  const confirmUrl = `${base}/waitlist/confirm?token=${encodeURIComponent(args.confirmToken)}`
  const unsubscribeUrl = `${base}/waitlist/unsubscribe?token=${encodeURIComponent(args.unsubscribeToken)}`
  const body = [
    copy.intro,
    '',
    copy.confirmLabel,
    confirmUrl,
    '',
    copy.expiry,
    '',
    copy.unsubscribeLabel,
    unsubscribeUrl,
    '',
    copy.ignore
  ].join('\n')
  return { subject: copy.subject, body }
}
