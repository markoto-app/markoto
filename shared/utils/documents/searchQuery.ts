// Document search input: a typed query turned into a Postgres `tsquery`
// string for the 'simple' text search configuration. Every word becomes a
// prefix match (`word:*`), all words must match. Only letters and digits
// survive, so the string can never carry tsquery operators of its own.

const MAX_TERMS = 8
const MAX_TERM_LENGTH = 64

/** The words of a query, lower case, letters and digits only (at most 8). */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []
  const out: string[] = []
  for (const w of words) {
    const term = w.slice(0, MAX_TERM_LENGTH)
    if (!out.includes(term)) out.push(term)
    if (out.length === MAX_TERMS) break
  }
  return out
}

/** `to_tsquery('simple', …)` input for the query, or null when it has no searchable word. */
export function prefixTsQuery(query: string): string | null {
  const terms = searchTerms(query)
  return terms.length === 0 ? null : terms.map(t => `${t}:*`).join(' & ')
}

/** Marks around the matched words in a search snippet (`ts_headline`); the client turns them into `<mark>`. */
export const SNIPPET_START = '⁣['
export const SNIPPET_STOP = ']⁣'

/** Markdown markers that only clutter a one-line excerpt (heading hashes, emphasis, code ticks). */
function plainExcerpt(text: string): string {
  return text.replace(/(^|\s)#{1,6}\s/g, '$1').replace(/[*_`]{1,3}/g, '').replace(/\s+/g, ' ')
}

/** Split a snippet into plain and matched parts (never HTML), without Markdown markers. */
export function splitSnippet(snippet: string): Array<{ text: string, match: boolean }> {
  const parts: Array<{ text: string, match: boolean }> = []
  let rest = plainExcerpt(snippet)
  while (rest.length > 0) {
    const start = rest.indexOf(SNIPPET_START)
    if (start === -1) {
      parts.push({ text: rest, match: false })
      break
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), match: false })
    const afterStart = rest.slice(start + SNIPPET_START.length)
    const stop = afterStart.indexOf(SNIPPET_STOP)
    if (stop === -1) {
      parts.push({ text: afterStart, match: false })
      break
    }
    parts.push({ text: afterStart.slice(0, stop), match: true })
    rest = afterStart.slice(stop + SNIPPET_STOP.length)
  }
  return parts.filter(p => p.text.length > 0)
}
