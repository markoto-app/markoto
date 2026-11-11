// Co-branding of a managed private instance (WP16): the customer's name
// and logo next to the markoto wordmark, and their support contact. Set
// by the operator in the instance's .env — nothing to configure in the
// app. Unset everywhere else (markoto.app, ordinary self-hosts): nothing
// changes. markoto's own design system stays (the seal is the AI).

type Env = Record<string, string | undefined>

export interface InstanceBrand {
  /** Customer name shown beside the wordmark, e.g. "Kanton Musterstadt". Empty = none. */
  name: string
  /** URL the app loads the customer logo from (`/instance-brand/logo.<ext>`), or null. */
  logoUrl: string | null
  /** Help / service-desk page for this instance (https), empty = none. */
  supportUrl: string
  /** Support email address, empty = none. */
  supportEmail: string
}

export const EMPTY_INSTANCE_BRAND: InstanceBrand = Object.freeze({ name: '', logoUrl: null, supportUrl: '', supportEmail: '' })

/** Logo formats the route serves, by file extension. */
export const INSTANCE_BRAND_LOGO_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg'
}

export const INSTANCE_BRAND_NAME_MAX = 60

/** Extension of the configured logo file, or null when it isn't a supported image. */
export function instanceBrandLogoExt(path: string | undefined): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec((path ?? '').trim())?.[1]?.toLowerCase()
  return ext && Object.hasOwn(INSTANCE_BRAND_LOGO_TYPES, ext) ? ext : null
}

export function resolveInstanceBrand(env: Env): InstanceBrand {
  // \p{Cc}: control characters (C0, DEL, C1) — kept out of the title and header.
  const name = (env.NUXT_INSTANCE_BRAND_NAME ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, INSTANCE_BRAND_NAME_MAX)
  const ext = instanceBrandLogoExt(env.NUXT_INSTANCE_BRAND_LOGO)
  let supportUrl = ''
  const rawUrl = (env.NUXT_INSTANCE_SUPPORT_URL ?? '').trim()
  if (rawUrl) {
    try {
      const u = new URL(rawUrl)
      if (u.protocol === 'https:' || u.protocol === 'http:') supportUrl = u.href
    } catch { /* invalid → none */ }
  }
  const rawEmail = (env.NUXT_INSTANCE_SUPPORT_EMAIL ?? '').trim()
  const supportEmail = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(rawEmail) && rawEmail.length <= 254 ? rawEmail : ''
  return { name, logoUrl: ext ? `/instance-brand/logo.${ext}` : null, supportUrl, supportEmail }
}
