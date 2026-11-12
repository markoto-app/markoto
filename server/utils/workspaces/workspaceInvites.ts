import { createHash, randomBytes } from 'node:crypto'
import { isValidEmailShape } from './emailShape'
import { DAY_MS, HOUR_MS } from '~~/shared/config/units'
import { trimTrailingSlashes } from '~~/shared/utils/trimTrailingSlashes'

// Workspace invitations (pending invite + accept).
//
// Inviting someone by email creates a `workspace_invites` row; the
// invitee becomes a member only by accepting it, in-app (the invite
// matches the verified email on their account) or through the emailed
// link (single-use token, SHA-256 at rest). The invite endpoint answers
// the same way whether or not the address has an account, and never
// returns profile data, so it is not an account-existence oracle.
//
// Pure helpers live here (unit-tested in `tests/unit/workspaces/workspaceInvites.test.ts`);
// the table access is in `server/repos/workspaceInvites.ts`.

/** How long an invite stays open. Expired rows are deleted by the sweeper. */
export const WORKSPACE_INVITE_TTL_MS = 14 * DAY_MS

/** Open (unexpired) invites a single workspace may have at once. */
export const WORKSPACE_INVITE_OPEN_CAP = 50

/** Invites one admin may send per hour (across all their workspaces). */
export const WORKSPACE_INVITE_PER_ADMIN_LIMIT = 20
/** Invites one workspace may send per hour (across all its admins). */
export const WORKSPACE_INVITE_PER_WORKSPACE_LIMIT = 30
export const WORKSPACE_INVITE_WINDOW_MS = HOUR_MS

/** Invite emails one address may receive per day (silently skipped beyond). */
export const WORKSPACE_INVITE_EMAILS_PER_ADDRESS = 3
export const WORKSPACE_INVITE_EMAIL_WINDOW_MS = DAY_MS

/** RFC 5321 caps a forward-path at 254 characters. */
const EMAIL_MAX_LENGTH = 254

// `guest`: sees only documents shared with them; takes no seat.
export type InviteRole = 'admin' | 'editor' | 'viewer' | 'guest'

export function isInviteRole(value: unknown): value is InviteRole {
  return value === 'admin' || value === 'editor' || value === 'viewer' || value === 'guest'
}

/**
 * Normalise an invite address: trim + lower-case. Null when it isn't a
 * plausible address. Invites are stored and matched in this form
 * (account emails are compared with `lower(users.email)`).
 */
export function normaliseInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return null
  return isValidEmailShape(email) ? email : null
}

/** 256-bit URL-safe token. Only ever sent by email, never stored raw. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

/** SHA-256 hex: the only form of a token (or address) kept server-side. */
export function hashInviteSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** A token from a request body: base64url of sane length, else null. */
export function parseInviteToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return /^[\w-]{20,128}$/.test(raw) ? raw : null
}

/** An invite id from a route param (nanoid), else null. */
export function parseInviteId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return /^[\w-]{8,32}$/.test(raw) ? raw : null
}

export const INVITE_EMAIL_LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
export type InviteEmailLocale = (typeof INVITE_EMAIL_LOCALES)[number]

export function normaliseInviteLocale(raw: unknown): InviteEmailLocale {
  return INVITE_EMAIL_LOCALES.find(l => l === raw) ?? 'en'
}

interface InviteEmailCopy {
  subject: (workspace: string) => string
  intro: (inviter: string, workspace: string, role: string) => string
  roles: Record<InviteRole, string>
  acceptLabel: string
  account: string
  expiry: string
  ignore: string
}

// Plain-text email copy (sendEmail.ts doesn't ship HTML). Server-side,
// outside the Vue i18n runtime, same approach as the waitlist email.
const INVITE_EMAIL_COPY: Record<InviteEmailLocale, InviteEmailCopy> = {
  en: {
    subject: w => `You're invited to the workspace "${w}" on markoto`,
    intro: (i, w, r) => `${i} invited you to join the workspace "${w}" on markoto as ${r}.`,
    roles: { admin: 'an admin', editor: 'an editor', viewer: 'a viewer', guest: 'a guest (you see only the documents shared with you)' },
    acceptLabel: 'Accept the invitation:',
    account: 'You\'ll be asked to sign in (or create an account) first. Signed in with this email address, you can also accept or decline from your markoto dashboard.',
    expiry: 'The invitation expires in 14 days.',
    ignore: 'If you weren\'t expecting this, ignore this email, nothing happens unless you accept.'
  },
  de: {
    subject: w => `Einladung in den Arbeitsbereich «${w}» auf markoto`,
    intro: (i, w, r) => `${i} hat Sie in den Arbeitsbereich «${w}» auf markoto eingeladen, als ${r}.`,
    roles: { admin: 'Admin', editor: 'Bearbeiter:in', viewer: 'Betrachter:in', guest: 'Gast (Sie sehen nur die Dokumente, die mit Ihnen geteilt werden)' },
    acceptLabel: 'Einladung annehmen:',
    account: 'Sie werden zuerst gebeten, sich anzumelden (oder ein Konto zu erstellen). Mit dieser E-Mail-Adresse angemeldet, können Sie die Einladung auch im markoto-Dashboard annehmen oder ablehnen.',
    expiry: 'Die Einladung läuft in 14 Tagen ab.',
    ignore: 'Falls Sie diese Einladung nicht erwartet haben, ignorieren Sie diese E-Mail, ohne Ihre Zustimmung passiert nichts.'
  },
  fr: {
    subject: w => `Invitation à l'espace de travail « ${w} » sur markoto`,
    intro: (i, w, r) => `${i} vous invite à rejoindre l'espace de travail « ${w} » sur markoto en tant que ${r}.`,
    roles: { admin: 'administrateur', editor: 'éditeur', viewer: 'lecteur', guest: 'invité (vous ne voyez que les documents partagés avec vous)' },
    acceptLabel: 'Accepter l\'invitation :',
    account: 'Vous devrez d\'abord vous connecter (ou créer un compte). Connecté avec cette adresse e-mail, vous pouvez aussi accepter ou refuser depuis votre tableau de bord markoto.',
    expiry: 'L\'invitation expire dans 14 jours.',
    ignore: 'Si vous n\'attendiez pas cette invitation, ignorez cet e-mail, rien ne se passe sans votre accord.'
  },
  es: {
    subject: w => `Invitación al espacio de trabajo «${w}» en markoto`,
    intro: (i, w, r) => `${i} te ha invitado a unirte al espacio de trabajo «${w}» en markoto como ${r}.`,
    roles: { admin: 'administrador', editor: 'editor', viewer: 'lector', guest: 'invitado (solo ves los documentos compartidos contigo)' },
    acceptLabel: 'Aceptar la invitación:',
    account: 'Primero tendrás que iniciar sesión (o crear una cuenta). Con la sesión iniciada con esta dirección de correo, también puedes aceptar o rechazar desde tu panel de markoto.',
    expiry: 'La invitación caduca en 14 días.',
    ignore: 'Si no esperabas esta invitación, ignora este correo: no pasará nada si no la aceptas.'
  },
  ja: {
    subject: w => `markoto のワークスペース「${w}」への招待`,
    intro: (i, w, r) => `${i} さんが markoto のワークスペース「${w}」に${r}として招待しました。`,
    roles: { admin: '管理者', editor: '編集者', viewer: '閲覧者', guest: 'ゲスト（共有されたドキュメントのみ表示されます）' },
    acceptLabel: '招待を承認する:',
    account: '最初にサインイン（またはアカウント作成）を求められます。このメールアドレスでサインインしていれば、markoto のダッシュボードから承認または辞退することもできます。',
    expiry: 'この招待は 14 日後に期限切れになります。',
    ignore: '心当たりがない場合は、このメールを無視してください。承認しない限り何も起こりません。'
  },
  zh: {
    subject: w => `邀请您加入 markoto 上的工作区“${w}”`,
    intro: (i, w, r) => `${i} 邀请您以${r}身份加入 markoto 上的工作区“${w}”。`,
    roles: { admin: '管理员', editor: '编辑者', viewer: '查看者', guest: '访客（只能看到与你共享的文档）' },
    acceptLabel: '接受邀请：',
    account: '您需要先登录（或创建账户）。使用此邮箱地址登录后，您也可以在 markoto 控制台中接受或拒绝邀请。',
    expiry: '此邀请将在 14 天后过期。',
    ignore: '如果您没有预料到这封邀请，请忽略此邮件，除非您接受，否则不会发生任何事情。'
  }
}

/** Clip user-supplied text (names) placed into an email. */
function clip(value: string, max: number): string {
  const oneLine = value.replaceAll(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/**
 * Build the invitation email. `baseUrl` must be the deployment's own
 * origin from configuration (`emailLinkBaseUrl`), never the request's
 * Host / Origin.
 */
export function buildWorkspaceInviteEmail(args: {
  locale: InviteEmailLocale
  baseUrl: string
  token: string
  inviterName: string
  workspaceName: string
  role: InviteRole
}): { subject: string, body: string } {
  const copy = INVITE_EMAIL_COPY[args.locale]
  const base = trimTrailingSlashes(args.baseUrl)
  const acceptUrl = `${base}/invites/accept?token=${encodeURIComponent(args.token)}`
  const workspace = clip(args.workspaceName, 80)
  const inviter = clip(args.inviterName, 60)
  const body = [
    copy.intro(inviter, workspace, copy.roles[args.role]),
    '',
    copy.acceptLabel,
    acceptUrl,
    '',
    copy.account,
    copy.expiry,
    '',
    copy.ignore
  ].join('\n')
  return { subject: copy.subject(workspace), body }
}
