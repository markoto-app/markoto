// The heading slug the editor's renderer gives a heading without an explicit
// `{#id}` (markdown-it-anchor + the table of contents, see
// `app/utils/markdown/renderMarkdown.ts`). Shared so the AI's structural
// edit tools can compute the anchor a heading has today and pin it as an
// explicit id before they rename the heading, keeping links to it working.

/**
 * An id that starts with a digit (heading "2024 results" → `2024-results`)
 * is a valid HTML id but not a valid CSS `#id` selector, and paged.js
 * resolves `target-counter()` / internal links with `querySelector('#…')`
 * without escaping; it throws and the whole preview stays blank. Such
 * slugs get an `h-` prefix.
 */
export function selectorSafeId(slug: string): string {
  return /^\p{N}/u.test(slug) ? `h-${slug}` : slug
}

/**
 * Same shape as GitHub's slugger: lowercase, strip punctuation, hyphenate
 * spaces; plus the `h-` prefix for a leading digit. The browser renderer
 * applies one more step on top (`clobberSafeId`, which needs a DOM).
 */
export function headingSlugBase(s: string): string {
  const slug = s
    .toLowerCase()
    .trim()
    .replace(/[\s\u00A0]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-+/g, '-')
    // No `--` runs remain after the collapse, so stripping a SINGLE
    // leading/trailing dash suffices (`/^-+|-+$/` backtracks super-linearly).
    .replace(/^-|-$/g, '')
  return selectorSafeId(slug)
}
