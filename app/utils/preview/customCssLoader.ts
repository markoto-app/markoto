import type { CustomCssResult } from '~~/shared/types/customCss'
import type { SanitizeCustomCssOptions } from '~~/shared/utils/theme/customCss'

/**
 * Browser-side entry to the custom-CSS sanitizer. The sanitizer pulls in
 * css-tree's parser + generator (~80 KB min / ~23 KB gzip), so it is
 * loaded on demand: documents without custom CSS never download it.
 */

type SanitizerModule = typeof import('~~/shared/utils/theme/customCss')

let modulePromise: Promise<SanitizerModule> | null = null

export function loadCustomCssSanitizer(): Promise<SanitizerModule> {
  if (!modulePromise) {
    modulePromise = import('~~/shared/utils/theme/customCss').catch((err: unknown) => {
      modulePromise = null
      throw err
    })
  }
  return modulePromise
}

const warned = new Set<string>()

/**
 * Render-path sanitize: returns the cleaned CSS to inline (offending
 * rules dropped), or `undefined` when the theme has none. Issues are
 * logged once per distinct input, the editor's Custom CSS section is
 * where they're shown to the author. Fails closed: if the sanitizer
 * can't be loaded or throws, the document renders without custom CSS
 * instead of failing the preview / print / server render.
 */
export async function sanitizeCustomCssForRender(
  css: string | undefined,
  opts: SanitizeCustomCssOptions
): Promise<CustomCssResult | undefined> {
  if (!css?.trim()) return undefined
  let result: CustomCssResult
  try {
    const { sanitizeCustomCss } = await loadCustomCssSanitizer()
    result = sanitizeCustomCss(css, opts)
  } catch (err: unknown) {
    console.warn('[custom css] not applied: sanitizer failed', err)
    return undefined
  }
  if (result.issues.length > 0) {
    const key = `${opts.docId}:${css}`
    if (!warned.has(key)) {
      if (warned.size > 50) warned.clear()
      warned.add(key)
      console.warn(`[custom css] ${result.issues.length} rule(s) were not applied`, result.issues)
    }
  }
  return result
}

/** The app's own origin(s), for absolute `/api/files/…` URLs in custom CSS. */
export function currentAppOrigins(): string[] {
  return globalThis.location?.origin ? [globalThis.location.origin] : []
}
