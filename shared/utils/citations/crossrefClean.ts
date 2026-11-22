/**
 * Tidying of a Crossref CSL JSON record before it becomes a bibliography
 * entry. Older publishers deposit metadata the way the print edition set
 * it: titles and author names in capitals, "I." plus a dash as section numerals in
 * front of the title, the journal missing next to a publisher. Pure and
 * dependency free (shared by the DOI lookup and its tests).
 */

/** Words kept lower case inside a title (not at its start). */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'vs', 'via', 'with'
])

/** Name particles kept lower case inside a family name. */
const NAME_PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'ten', 'ter', 'bin', 'ibn', 'al', 'el'])

/** Abbreviations that stay in capitals when a title is recased. */
const ACRONYMS = new Set([
  'AI', 'API', 'BBC', 'CERN', 'CO2', 'CPU', 'DNA', 'EU', 'FBI', 'GDP', 'GPS', 'GPU', 'HIV', 'IBM', 'ICT', 'II', 'III', 'IV', 'IQ', 'MIT', 'NASA', 'NATO', 'NHS', 'OECD', 'PDF', 'RNA', 'UK', 'UN', 'UNESCO', 'USA', 'USSR', 'VI', 'VII', 'VIII', 'WWI', 'WWII', 'XML'
])

const LETTER = /\p{L}/u
const LOWER = /\p{Ll}/u

/** True when the text has letters and none of them is lower case. */
export function isAllCaps(text: string): boolean {
  return LETTER.test(text) && !LOWER.test(text)
}

/** First letter upper case, the rest lower case. */
function capitalize(word: string): string {
  const [first = '', ...rest] = [...word]
  return first.toLocaleUpperCase() + rest.join('').toLocaleLowerCase()
}

/** A word of a title: acronym, initial or abbreviation with dots stays; the rest is recased. */
function titleWord(word: string, atStart: boolean): string {
  const bare = word.replace(/[^\p{L}\p{N}]/gu, '')
  if (bare.length === 0) return word
  // "U.S.", "A.", "3D": initials, dotted abbreviations and words with digits stay as deposited.
  if (/\p{N}/u.test(bare) || /^\p{L}(?:\.\p{L})+\.?$/u.test(word) || ACRONYMS.has(bare)) return word
  const lower = word.toLocaleLowerCase()
  if (!atStart && SMALL_WORDS.has(bare.toLocaleLowerCase())) return lower
  return capitalize(word)
}

/**
 * An ALL-CAPS title as a title ("COMPUTING MACHINERY AND INTELLIGENCE" ->
 * "Computing Machinery and Intelligence"). Text that already has lower
 * case letters is returned unchanged.
 */
export function recaseTitle(text: string): string {
  if (!isAllCaps(text)) return text
  const words = text.split(/(\s+)/)
  let seenWord = false
  let afterBreak = false
  return words.map((chunk) => {
    if (/^\s*$/.test(chunk)) return chunk
    const atStart = !seenWord || afterBreak
    seenWord = true
    const parts = chunk.split('-')
    const out = parts.map((part, i) => titleWord(part, atStart && i === 0)).join('-')
    afterBreak = /[:?!]$/.test(chunk)
    return out
  }).join('')
}

/** One part of a name ("TURING", "A. M.", "VAN DER BERG", "SMITH-JONES"). Mixed-case input is unchanged. */
export function recaseName(text: string): string {
  if (!isAllCaps(text)) return text
  return text.split(/(\s+)/).map((chunk, i) => {
    if (/^\s*$/.test(chunk)) return chunk
    const bare = chunk.replace(/[^\p{L}]/gu, '')
    // Initials ("A.", "A.M.", "J") stay capital.
    if (bare.length <= 1 || /^\p{L}(?:\.\p{L})+\.?$/u.test(chunk)) return chunk
    if (i > 0 && NAME_PARTICLES.has(bare.toLocaleLowerCase())) return chunk.toLocaleLowerCase()
    return chunk.split('-').map(part => part.split('\'').map(capitalize).join('\'')).join('-')
  }).join('')
}

/**
 * A leading section numeral ("I." plus a dash, "II. ", "IV.-") removed from a title.
 * Needs the dot (or a dash after the numeral), so "I Am Legend" and
 * "X-Ray" stay as they are.
 */
export function stripNumeralPrefix(title: string): string {
  const m = /^\s*[IVXLC]{1,6}(?:\s*\.\s*[\u2014\u2013-]*|\s*[\u2014\u2013])\s*/.exec(title)
  if (!m) return title
  const rest = title.slice(m[0].length).trim()
  return rest.length > 0 ? rest : title
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (Array.isArray(v)) return str(v.find(x => typeof x === 'string' && x.trim()))
  return undefined
}

function cleanNames(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.map((n) => {
    if (!n || typeof n !== 'object') return n
    const name = { ...(n as Record<string, unknown>) }
    for (const part of ['family', 'given'] as const) {
      const v = name[part]
      if (typeof v === 'string') name[part] = recaseName(v)
    }
    if (typeof name.literal === 'string') name.literal = recaseName(name.literal)
    return name
  })
}

/**
 * The record with a readable title and names, the journal as
 * `container-title` (a list or the short form is accepted; the publisher
 * never stands in for it), and volume / issue / pages carried over
 * (`article-number` where there are no pages).
 */
export function cleanCrossrefRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record }

  const title = str(record.title)
  if (title) out.title = recaseTitle(stripNumeralPrefix(title))

  const container = str(record['container-title']) ?? str(record['short-container-title'])
  if (container) {
    out['container-title'] = recaseTitle(container)
    // A journal article is cited by its journal; the publisher is noise next to it.
    if (record.type === 'article-journal') delete out.publisher
  } else {
    delete out['container-title']
  }

  for (const field of ['author', 'editor', 'translator'] as const) {
    if (record[field] !== undefined) out[field] = cleanNames(record[field])
  }

  for (const field of ['volume', 'issue', 'page'] as const) {
    const v = str(record[field])
    if (v) out[field] = v
  }
  if (!out.page) {
    const article = str(record['article-number'])
    if (article) out.page = article
  }
  return out
}
