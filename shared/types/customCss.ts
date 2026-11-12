/**
 * Types + limits for a document's custom CSS (`theme.customCss`).
 *
 * Kept free of any `css-tree` import so `shared/types/theme.ts` (the Zod
 * schema) and `shared/utils/theme/themeToCss.ts` can reference them without
 * pulling the CSS parser into every bundle. The parser-backed sanitizer
 * itself lives in `shared/utils/theme/customCss.ts`; browser code loads it
 * lazily through `app/utils/preview/customCssLoader.ts`.
 */

/** Hard cap on stored custom CSS, in UTF-8 bytes. */
export const CUSTOM_CSS_MAX_BYTES = 64 * 1024

/**
 * Machine-readable reason for a rejected construct. The UI localises by
 * code; `message` is the English fallback the API + AI tools return.
 */
export type CustomCssIssueCode
  = | 'too-large'
    | 'syntax'
    | 'at-rule'
    | 'property'
    | 'function'
    | 'url'
    | 'svg-data-url'
    | 'other-doc-file'
    | 'script-url'
    | 'value'

export interface CustomCssIssue {
  code: CustomCssIssueCode
  /** English, user-facing. Does not repeat the position. */
  message: string
  /** 1-based. */
  line: number
  /** 1-based. */
  column: number
  /** The offending name / URL (truncated), for localised messages. */
  detail?: string
}

/**
 * Output of the sanitizer. `css` is ALWAYS the re-serialised AST with
 * every offending rule / declaration removed, never the raw input, so
 * it is safe to inline in a `<style>` element even when `issues` is
 * non-empty. Write paths reject on any issue; render paths use `css`
 * and drop the issues (logging once).
 */
export interface CustomCssResult {
  css: string
  issues: CustomCssIssue[]
  /** Every URL left in `css` (normalised), so renderers can preload them. */
  urls: string[]
}

/** `data.code` of the 400 a write path answers when custom CSS is rejected. */
export const CUSTOM_CSS_INVALID_CODE = 'theme/custom-css-invalid'

/** UTF-8 length without allocating a buffer per call site. */
export function customCssByteLength(css: string): number {
  return new TextEncoder().encode(css).length
}
