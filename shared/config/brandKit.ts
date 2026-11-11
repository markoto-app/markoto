// Workspace brand kit: uploaded fonts + logos, the locked workspace
// design, workspace templates. Limits and shapes shared by the API and
// the UI. The plan switch is `brandKit` (shared/config/tiers.ts).

/** Font files per workspace (one file = one family + weight + style). */
export const BRAND_FONTS_PER_WORKSPACE = 40
/** Brand images (logos) per workspace. */
export const BRAND_IMAGES_PER_WORKSPACE = 20
/** One font file. */
export const BRAND_FONT_MAX_BYTES = 10 * 1024 * 1024
/** One brand image. */
export const BRAND_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Workspace templates per workspace. */
export const WORKSPACE_TEMPLATES_PER_WORKSPACE = 50
export const WORKSPACE_TEMPLATE_NAME_MAX = 80
export const WORKSPACE_TEMPLATE_DESCRIPTION_MAX = 200

export const BRAND_FONT_FORMATS = ['woff2', 'woff', 'ttf'] as const
export type BrandFontFormat = typeof BRAND_FONT_FORMATS[number]
export const BRAND_IMAGE_FORMATS = ['png', 'jpg', 'webp'] as const
export type BrandImageFormat = typeof BRAND_IMAGE_FORMATS[number]
export type BrandAssetFormat = BrandFontFormat | BrandImageFormat

export const BRAND_ASSET_CONTENT_TYPES: Record<BrandAssetFormat, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp'
}

/** CSS `format()` hint for each font format. */
export const BRAND_FONT_CSS_FORMAT: Record<BrandFontFormat, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype'
}

/** `<assetId>.<ext>` — the served file name of a brand asset. */
export const BRAND_ASSET_FILE_RE = /^([A-Za-z0-9_-]{16})\.(woff2|woff|ttf|png|jpg|webp)$/

/** A workspace font as the renderers need it. */
export interface BrandFont {
  /** `<assetId>.<ext>` */
  file: string
  family: string
  weight: number
  style: 'normal' | 'italic'
  format: BrandFontFormat
}

/** Same pattern the theme schema allows for font names (shared/types/theme.ts). */
export const BRAND_FONT_FAMILY_RE = /^[A-Za-z0-9 ]{1,40}$/

/** Refusal codes of the font inspector (`server/utils/brandKit/fontInspect.ts`). */
export type FontRefusal
  = | 'not-a-font'
    | 'collection'
    | 'variable'
    | 'cff'
    | 'no-embedding'
    | 'damaged'
