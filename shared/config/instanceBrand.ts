// Co-branding of a managed private instance: the customer's name
// and logo next to the markoto wordmark, and their support contact. Set
// by the operator in the instance's .env — nothing to configure in the
// app. Unset everywhere else (markoto.app, ordinary self-hosts): nothing
// changes. markoto's own design system stays (the seal is the AI).

import { useEnv } from '../env/load'
import type { RawEnv } from '../env/define'

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
export const INSTANCE_BRAND_LOGO_TYPES = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg'
} as const
export type InstanceBrandLogoExt = keyof typeof INSTANCE_BRAND_LOGO_TYPES

function isInstanceBrandLogoExt(ext: string): ext is InstanceBrandLogoExt {
  return Object.hasOwn(INSTANCE_BRAND_LOGO_TYPES, ext)
}

const INSTANCE_BRAND_NAME_MAX = 60

/** Extension of the configured logo file, or null when it isn't a supported image. */
export function instanceBrandLogoExt(path: string | undefined): InstanceBrandLogoExt | null {
  const ext = /\.([a-z0-9]+)$/i.exec((path ?? '').trim())?.[1]?.toLowerCase()
  return ext && isInstanceBrandLogoExt(ext) ? ext : null
}

export function resolveInstanceBrand(source?: RawEnv): InstanceBrand {
  const { brand } = useEnv(source)
  // \p{Cc}: control characters (C0, DEL, C1) — kept out of the title and header.
  const name = brand.name.replace(/\p{Cc}/gu, '').trim().slice(0, INSTANCE_BRAND_NAME_MAX)
  const ext = instanceBrandLogoExt(brand.logo)
  return {
    name,
    logoUrl: ext ? `/instance-brand/logo.${ext}` : null,
    supportUrl: brand.supportUrl ? new URL(brand.supportUrl).href : '',
    supportEmail: brand.supportEmail ?? ''
  }
}
