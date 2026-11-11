import type { PageOrientation, PageSize } from '../../types/theme'

/**
 * Physical page dimensions in millimetres. Centralised so that any code
 * needing the page rectangle (cover-page CSS height, future PDF viewers,
 * etc.) reads from one table — adding `Legal` / `A3` / `B5` to the
 * `PageSizeSchema` enum and forgetting to update the table would silently
 * shift cover layouts before this module existed.
 *
 * The TS exhaustiveness pattern at the bottom of `pageHeightMm` makes
 * forgetting a size a compile error, not a layout bug. If you see a
 * `Type 'X' is not assignable to type 'never'` error here, you added a
 * new PageSize without giving it dimensions.
 *
 * Source: ISO 216 (A4, A5) and ANSI/ASME Y14.1 (Letter, Legal). Values in mm,
 * standard portrait orientation. Landscape swaps width ↔ height.
 */

export interface PageRect {
  /** Long dimension when in portrait, in mm. */
  portraitHeightMm: number
  /** Short dimension when in portrait, in mm. */
  portraitWidthMm: number
}

/**
 * Switch-based dispatch instead of a Record lookup, so adding a new
 * PageSize variant fails compile here. With `Record<PageSize, PageRect>`
 * the lookup never narrows `size` to `never`, which masks the missing-
 * entry case. The switch's `default: const _: never = size` IS the
 * exhaustiveness fence.
 */
function rectFor(size: PageSize): PageRect {
  switch (size) {
    case 'A4': return { portraitHeightMm: 297, portraitWidthMm: 210 }
    case 'A5': return { portraitHeightMm: 210, portraitWidthMm: 148 }
    case 'Letter': return { portraitHeightMm: 279.4, portraitWidthMm: 215.9 }
    case 'Legal': return { portraitHeightMm: 355.6, portraitWidthMm: 215.9 }
    default: {
      // Compile fails here when PageSizeSchema gains a new value and
      // this switch isn't updated. Cover layouts will look right; the
      // build won't.
      const _exhaustive: never = size
      throw new Error(`Missing rect for page size: ${String(_exhaustive)}`)
    }
  }
}

/** Page height in millimetres for the given size + orientation. */
export function pageHeightMm(size: PageSize, orientation: PageOrientation): number {
  const rect = rectFor(size)
  return orientation === 'portrait' ? rect.portraitHeightMm : rect.portraitWidthMm
}

/** Page width in millimetres. Symmetric to `pageHeightMm`. */
export function pageWidthMm(size: PageSize, orientation: PageOrientation): number {
  const rect = rectFor(size)
  return orientation === 'portrait' ? rect.portraitWidthMm : rect.portraitHeightMm
}
