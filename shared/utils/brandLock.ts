import type { DocTheme } from '../types/theme'

/**
 * The locked workspace design (brand kit, WP10). While a workspace's admins
 * lock its design, every document in it renders with the workspace design
 * (`workspaces.default_theme`) — fonts, colours, logo, page, headings,
 * header / footer, custom CSS — and keeps only its own cover TEXT: subtitle,
 * date, authors and affiliations (the title is the document's title anyway).
 *
 * Enforced at render time in all three renderers (live preview, browser
 * print, server PDF / the AI's page views), like custom CSS: the document's
 * stored theme is never rewritten, so unlocking gives every document its
 * own design back.
 */
export const DOC_OWNED_COVER_FIELDS = ['subtitle', 'date', 'authors', 'affiliations'] as const

export function applyBrandLock(docTheme: DocTheme | null | undefined, brandTheme: DocTheme): DocTheme
export function applyBrandLock(docTheme: DocTheme, brandTheme: DocTheme | null | undefined): DocTheme
export function applyBrandLock(docTheme: DocTheme | null | undefined, brandTheme: DocTheme | null | undefined): DocTheme | null | undefined {
  if (!brandTheme) return docTheme
  // The document theme may have arrived over Y.js unchecked: take each
  // cover field only when it has the right shape (the renderers validate
  // the RESULT again).
  const own = (docTheme?.cover ?? {}) as Partial<Record<string, unknown>>
  const cover = { ...brandTheme.cover }
  if (typeof own.subtitle === 'string') cover.subtitle = own.subtitle
  if (Array.isArray(own.authors) && own.authors.every(a => typeof a === 'string')) cover.authors = own.authors as string[]
  if (typeof own.date === 'string') cover.date = own.date
  else delete cover.date
  if (Array.isArray(own.affiliations) && own.affiliations.every(a => typeof a === 'string')) cover.affiliations = own.affiliations as string[]
  else delete cover.affiliations
  return { ...brandTheme, cover }
}

/** Theme-panel sections that the lock takes over (read-only while locked). */
export function isLockedThemePath(path: string): boolean {
  const [section, field] = path.split('.')
  if (section !== 'cover') return true
  return !(DOC_OWNED_COVER_FIELDS as readonly string[]).includes(field ?? '')
}
