import { ANON_GATE_CODES } from '~~/shared/config/anonGate'

// Pure helpers of the marketing `::try-it` block (components/content/TryIt.vue
// + components/marketing/TryItWorkbench.vue).

/** Same cap as the server's document title (createDocument TITLE_MAX_LENGTH). */
const TITLE_MAX = 255

/**
 * The document title for the visitor's text: the first ATX heading
 * (`# Title`, any level), without closing hashes. '' when there is none —
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
    const m = /^\s{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (m?.[1]) return m[1].trim().slice(0, TITLE_MAX)
  }
  return ''
}

/**
 * The text without its title line: a level-1 ATX heading on the first
 * non-blank line, plus the blank lines after it. Used for themes that set
 * the title in a title block on page 1 (papers): the heading is the
 * document title there, and left in the body it would print twice.
 * Anything else (no heading first, a level-2 heading) is returned as is.
 */
export function withoutTitleHeading(markdown: string): string {
  const lines = markdown.split('\n')
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  if (!/^\s{0,3}#[ \t]+\S/.test(lines[i] ?? '')) return markdown
  i++
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  return lines.slice(i).join('\n')
}

/** Status + code of a `$fetch` error, whatever its exact shape. */
function errorParts(e: unknown): { status: number | null, code: string | null, messageKey: string | null } {
  if (typeof e !== 'object' || e === null) return { status: null, code: null, messageKey: null }
  const err = e as Record<string, unknown>
  const status = typeof err.statusCode === 'number'
    ? err.statusCode
    : typeof err.status === 'number' ? err.status : null
  const data = typeof err.data === 'object' && err.data !== null ? err.data as Record<string, unknown> : null
  const inner = data && typeof data.data === 'object' && data.data !== null ? data.data as Record<string, unknown> : null
  const pick = (k: string): string | null => {
    if (data && typeof data[k] === 'string') return data[k]
    if (inner && typeof inner[k] === 'string') return inner[k]
    return null
  }
  return { status, code: pick('code'), messageKey: pick('messageKey') }
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
