import type { ApiResponse } from '~/utils/api/client'
import { BRAND_FONT_FORMATS, type BrandFont, type BrandFontFormat } from '~~/shared/config/brandKit'

/** The workspace brand kit as members and admins see it (`GET /api/workspaces/:wsId/brand`). */
export type BrandKit = ApiResponse<'/api/workspaces/:wsId/brand', 'get'>
export type BrandKitFontRow = BrandKit['fonts'][number]

function isFontFormat(format: string): format is BrandFontFormat {
  return (BRAND_FONT_FORMATS as readonly string[]).includes(format)
}

/**
 * The kit's fonts as `BrandFont`s. The endpoint types a font's `format` as
 * any asset format (it separates fonts from images at runtime), so the
 * font formats are checked here instead of assumed.
 */
export function kitFonts(kit: BrandKit | null | undefined): BrandFont[] {
  return (kit?.fonts ?? []).flatMap(f => isFontFormat(f.format)
    ? [{ file: f.file, family: f.family, weight: f.weight, style: f.style, format: f.format }]
    : [])
}

export type AddedFont = ApiResponse<'/api/workspaces/:wsId/brand/fonts', 'post'>

/** The font upload is a multipart POST that `apiFetch` cannot type, so its answer is checked at runtime. */
export function isAddedFont(value: unknown): value is AddedFont {
  if (typeof value !== 'object' || value === null) return false
  return 'family' in value && typeof value.family === 'string'
    && 'weight' in value && typeof value.weight === 'number'
    && 'style' in value && typeof value.style === 'string'
}
