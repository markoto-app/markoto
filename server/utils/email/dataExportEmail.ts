import type { InviteEmailLocale } from '../workspaces/workspaceInvites'

// The "your data export is ready" email: plain text, in the account's
// language, with the full address of the profile page on its own line so
// mail clients turn it into a link.

interface Copy {
  subject: string
  ready: string
  open: string
  /** Shown without a site URL: where to go by hand. */
  openWithoutLink: string
  expires: (days: number) => string
}

const COPY: Record<InviteEmailLocale, Copy> = {
  en: {
    subject: 'Your markoto data export is ready',
    ready: 'Your data export is ready to download.',
    open: 'Sign in and click "Download" on your profile:',
    openWithoutLink: 'Sign in, open Settings → Profile and click "Download".',
    expires: days => `The download is available for ${days} days.`
  },
  de: {
    subject: 'Dein markoto-Datenexport ist bereit',
    ready: 'Dein Datenexport steht zum Herunterladen bereit.',
    open: 'Melde dich an und klicke in deinem Profil auf «Herunterladen»:',
    openWithoutLink: 'Melde dich an, öffne Einstellungen → Profil und klicke auf «Herunterladen».',
    expires: days => `Der Download ist ${days} Tage verfügbar.`
  },
  fr: {
    subject: 'Votre export de données markoto est prêt',
    ready: 'Votre export de données est prêt à être téléchargé.',
    open: 'Connectez-vous et cliquez sur « Télécharger » dans votre profil :',
    openWithoutLink: 'Connectez-vous, ouvrez Paramètres → Profil et cliquez sur « Télécharger ».',
    expires: days => `Le téléchargement est disponible pendant ${days} jours.`
  },
  es: {
    subject: 'Tu exportación de datos de markoto está lista',
    ready: 'Tu exportación de datos está lista para descargar.',
    open: 'Inicia sesión y haz clic en «Descargar» en tu perfil:',
    openWithoutLink: 'Inicia sesión, abre Ajustes → Perfil y haz clic en «Descargar».',
    expires: days => `La descarga está disponible durante ${days} días.`
  },
  ja: {
    subject: 'markoto のデータエクスポートの準備ができました',
    ready: 'データエクスポートをダウンロードできます。',
    open: 'ログインして、プロフィールの「ダウンロード」をクリックしてください：',
    openWithoutLink: 'ログインして、設定 → プロフィールを開き、「ダウンロード」をクリックしてください。',
    expires: days => `ダウンロードは ${days} 日間利用できます。`
  },
  zh: {
    subject: '你的 markoto 数据导出已就绪',
    ready: '你的数据导出可以下载了。',
    open: '请登录，然后在个人资料页点击“下载”：',
    openWithoutLink: '请登录，打开设置 → 个人资料，然后点击“下载”。',
    expires: days => `下载链接 ${days} 天内有效。`
  }
}

/**
 * Pure: subject + body. `baseUrl` is the configured site origin
 * (`emailLinkBaseUrl`), never the request host; without one the mail
 * names the page instead of linking to it.
 */
export function buildDataExportReadyEmail(locale: InviteEmailLocale, baseUrl: string | null, retentionDays: number): { subject: string, body: string } {
  const copy = COPY[locale]
  const lines = [copy.ready, '']
  if (baseUrl) lines.push(copy.open, `${baseUrl}/settings/profile`)
  else lines.push(copy.openWithoutLink)
  lines.push('', copy.expires(retentionDays))
  return { subject: copy.subject, body: lines.join('\n') }
}
