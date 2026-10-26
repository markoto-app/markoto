import type { H3Event } from 'h3'
import { sanitizeCustomCss, formatCustomCssIssues } from '~~/shared/utils/customCss'
import { CUSTOM_CSS_INVALID_CODE, type CustomCssIssue } from '~~/shared/types/customCss'

/**
 * Write-path gate for `theme.customCss`. Every endpoint / tool that
 * stores a theme (doc meta, saved themes, workspace default theme, the
 * AI + MCP `update_theme`) runs the shared sanitizer and refuses the
 * write on ANY issue, so what lands in the DB always re-serialises
 * cleanly. Render paths sanitize again regardless (Y.js bypasses this).
 */

/** Origins whose absolute `/api/files/…` URLs count as "this app". */
export function customCssAppOrigins(event?: H3Event): string[] {
  const origins = new Set<string>()
  const siteUrl = useRuntimeConfig().siteUrl
  if (typeof siteUrl === 'string' && siteUrl) {
    try {
      origins.add(new URL(siteUrl).origin)
    } catch { /* malformed NUXT_SITE_URL — ignore, relative URLs still work */ }
  }
  if (event) origins.add(getRequestURL(event).origin)
  return [...origins]
}

/** Issues for a theme's custom CSS, or `[]` when absent / clean. */
export function themeCustomCssIssues(
  theme: { customCss?: string } | null | undefined,
  docId: string | null,
  origins: readonly string[]
): CustomCssIssue[] {
  const css = theme?.customCss
  if (css === undefined || css.trim() === '') return []
  return sanitizeCustomCss(css, { docId, allowedOrigins: origins }).issues
}

/**
 * Throw 400 `theme/custom-css-invalid` when the theme's custom CSS has
 * any issue. `data.issues` carries `{code, message, line, column}` per
 * problem for the editor's inline error list.
 */
export function assertValidThemeCustomCss(
  theme: { customCss?: string } | null | undefined,
  docId: string | null,
  event?: H3Event
): void {
  const issues = themeCustomCssIssues(theme, docId, customCssAppOrigins(event))
  if (issues.length === 0) return
  throw createError({
    statusCode: 400,
    message: `Custom CSS rejected:\n${formatCustomCssIssues(issues)}`,
    data: { code: CUSTOM_CSS_INVALID_CODE, issues }
  })
}
