import { ANON_GATE_CODES } from '~~/shared/config/anonGate'
import { DOC_TITLE_MAX_LENGTH } from '~~/shared/config/docCreate'
import { apiErrorData, errorStatus } from '~/utils/api/errors'
import { trimTrailing } from '~/utils/markdown/trimTrailing'

export { withoutTitleHeading } from '~~/shared/utils/markdown/markdownTitle'

// Pure helpers of the marketing `::try-it` block (components/content/TryIt.vue
// + components/marketing/TryItWorkbench.vue).

/**
 * The document title for the visitor's text: the first ATX heading
 * (`# Title`, any level), without closing hashes. '' when there is none,
 * the server then uses its default title.
 */
export function titleFromMarkdown(markdown: string): string {
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^\s{0,3}#{1,6}[ \t]/.exec(line)
    if (m) {
      // The optional closing "###" is stripped by hand: a lazy group followed
      // by optional whitespace backtracks quadratically on long lines.
      const text = line.slice(m[0].length).trim()
      const hashes = trimTrailing(text, '#')
      const closing = hashes.length < text.length && (hashes.length === 0 || /\s/.test(hashes.charAt(hashes.length - 1)))
      const title = (closing ? hashes : text).trim()
      if (title) return title.slice(0, DOC_TITLE_MAX_LENGTH)
    }
  }
  return ''
}

/** Status + code of a `$fetch` error, whatever its exact shape. */
function errorParts(e: unknown): { status: number | null, code: string | null } {
  const code = apiErrorData(e)?.code
  return { status: errorStatus(e), code: typeof code === 'string' ? code : null }
}

/**
 * i18n key explaining why creating the document (`phase: 'create'`) or
 * the PDF (`phase: 'pdf'`) was refused. Gate and rate-limit refusals get
 * their own sentence; anything else a generic one.
 */
export function tryItErrorKey(e: unknown, phase: 'create' | 'pdf'): string {
  const { status, code } = errorParts(e)
  if (phase === 'create') {
    if (code === ANON_GATE_CODES.termsRequired) return 'anonGate.errors.termsRequired'
    if (code === ANON_GATE_CODES.unavailable || code === ANON_GATE_CODES.misconfigured) return 'anonGate.errors.unavailable'
    if (code?.startsWith('anon-gate/')) return 'anonGate.errors.botCheck'
    if (code === 'docs/rate-limited' || status === 429) return 'anonGate.errors.rateLimited'
    if (code === 'docs/content-too-long') return 'marketing.tryIt.errors.tooLong'
    return 'marketing.tryIt.errors.create'
  }
  if (status === 429) return 'marketing.tryIt.errors.pdfRateLimited'
  return 'marketing.tryIt.errors.pdf'
}
