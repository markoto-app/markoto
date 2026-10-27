/**
 * Theme image URLs: the cover logo (`brand.logoUrl`) and the running
 * header/footer image (`header.imageUrl`, `footer.imageUrl`).
 *
 * The editor only ever fills these from the image-upload flow
 * (`/api/files/<docId>/<fileId>`), and the built-in presets point at a
 * bundled brand asset. Anything else is refused: the values end up in an
 * HTML attribute (cover `<img src>`) and a CSS `url()` (margin boxes), so
 * the accepted shape is narrow enough that neither context needs to
 * trust its escaping.
 *
 * Zod-free on purpose — the server render page imports this eagerly
 * during SSR, where the zod import wedges (see
 * `app/pages/_internal/render/[docId].vue`). The schema in
 * `shared/types/theme.ts` reuses `THEME_IMAGE_URL_RE`.
 */

const ID_PART = '[A-Za-z0-9_-]{1,64}'
const UPLOAD_PATH = String.raw`/api/files/(${ID_PART})/${ID_PART}\.(?:png|jpe?g|gif|webp)`
const BUNDLED_ASSET = String.raw`/markoto-logos/[a-z0-9-]{1,64}\.(?:svg|png)`

/** `''` (no image), an upload path, or a bundled brand asset. */
export const THEME_IMAGE_URL_RE = new RegExp(String.raw`^(?:${UPLOAD_PATH}|${BUNDLED_ASSET})?$`)

const UPLOAD_PATH_RE = new RegExp(String.raw`^${UPLOAD_PATH}$`)

/** Shape check only: is `url` an acceptable theme image URL for SOME document? */
export function isThemeImageUrl(url: unknown): url is string {
  return typeof url === 'string' && THEME_IMAGE_URL_RE.test(url)
}

/** Shape check plus: an upload path must belong to `docId`. */
export function isThemeImageUrlForDoc(url: unknown, docId: string): boolean {
  if (!isThemeImageUrl(url)) return false
  const upload = UPLOAD_PATH_RE.exec(url)
  return upload === null || upload[1] === docId
}

/** The image fields of a `DocTheme`, so callers don't need the zod-derived type. */
export interface ThemeImageFields {
  brand: { logoUrl: string }
  header: { imageUrl: string }
  footer: { imageUrl: string }
}

export type ThemeImageField = 'brand.logoUrl' | 'header.imageUrl' | 'footer.imageUrl'

/**
 * Copy of `theme` with every image URL that `docId` can't use (another
 * document's upload, or anything that isn't an accepted shape) blanked.
 * Returns the input object itself when nothing changes.
 *
 * Used at render time by all three renderers (theme JSON can arrive over
 * Y.js without passing an HTTP validator) and when a theme is moved to a
 * document it wasn't made in (saved theme, workspace default, AI base
 * theme).
 */
export function themeImagesForDoc<T extends ThemeImageFields>(theme: T, docId: string): { theme: T, dropped: ThemeImageField[] } {
  const logoOk = isThemeImageUrlForDoc(theme.brand.logoUrl, docId)
  const headerOk = isThemeImageUrlForDoc(theme.header.imageUrl, docId)
  const footerOk = isThemeImageUrlForDoc(theme.footer.imageUrl, docId)
  const dropped: ThemeImageField[] = []
  if (!logoOk) dropped.push('brand.logoUrl')
  if (!headerOk) dropped.push('header.imageUrl')
  if (!footerOk) dropped.push('footer.imageUrl')
  if (dropped.length === 0) return { theme, dropped }
  return {
    theme: {
      ...theme,
      brand: logoOk ? theme.brand : { ...theme.brand, logoUrl: '' },
      header: headerOk ? theme.header : { ...theme.header, imageUrl: '' },
      footer: footerOk ? theme.footer : { ...theme.footer, imageUrl: '' }
    },
    dropped
  }
}

/**
 * Point a duplicated document's theme images at the copy's own uploads
 * (`/api/files/<source>/…` → `/api/files/<target>/…`). Values that don't
 * belong to the source are left as they are.
 */
export function withThemeImagesDocId<T extends ThemeImageFields>(theme: T, sourceDocId: string, targetDocId: string): T {
  const from = `/api/files/${sourceDocId}/`
  const move = (url: string): string => (url.startsWith(from) ? `/api/files/${targetDocId}/${url.slice(from.length)}` : url)
  return {
    ...theme,
    brand: { ...theme.brand, logoUrl: move(theme.brand.logoUrl) },
    header: { ...theme.header, imageUrl: move(theme.header.imageUrl) },
    footer: { ...theme.footer, imageUrl: move(theme.footer.imageUrl) }
  }
}
