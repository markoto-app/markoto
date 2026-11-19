/**
 * Bibliography entries as CSL JSON (the Citation Style Language data
 * format Pandoc, Zotero and Crossref speak), reduced to the fields the
 * formatter uses. Every entry that enters a document (BibTeX import, CSL
 * JSON import, DOI lookup, AI tool, Y.js write by any editor) goes through
 * `normalizeCslItem`, so readers can rely on the shape and the bounds.
 */

export interface CslName {
  'family'?: string
  'given'?: string
  'literal'?: string
  'non-dropping-particle'?: string
  'dropping-particle'?: string
  'suffix'?: string
}

export interface CslDate {
  'date-parts'?: number[][]
  'literal'?: string
}

export const CSL_TEXT_FIELDS = [
  'title', 'title-short', 'container-title', 'container-title-short', 'collection-title',
  'publisher', 'publisher-place', 'event-title', 'volume', 'issue', 'page', 'edition',
  'number', 'genre', 'DOI', 'URL', 'ISBN', 'ISSN', 'note', 'language', 'medium', 'version'
] as const

export type CslTextField = typeof CSL_TEXT_FIELDS[number]

export const CSL_NAME_FIELDS = ['author', 'editor', 'translator'] as const
export type CslNameField = typeof CSL_NAME_FIELDS[number]

export const CSL_DATE_FIELDS = ['issued', 'accessed'] as const
export type CslDateField = typeof CSL_DATE_FIELDS[number]

export type CslItem = {
  id: string
  type: string
} & Partial<Record<CslTextField, string>>
& Partial<Record<CslNameField, CslName[]>>
& Partial<Record<CslDateField, CslDate>>

/** CSL item types the formatter distinguishes; anything else becomes `document`. */
export const CSL_TYPES = new Set([
  'article', 'article-journal', 'article-magazine', 'article-newspaper', 'book', 'chapter',
  'paper-conference', 'report', 'thesis', 'webpage', 'post', 'post-weblog', 'dataset',
  'software', 'manuscript', 'document', 'entry-encyclopedia', 'entry-dictionary', 'patent',
  'speech', 'interview', 'motion_picture', 'standard', 'legislation', 'legal_case'
])

/** Bounds: one document's bibliography. */
export const BIBLIOGRAPHY_MAX_ENTRIES = 2000
export const CSL_TEXT_MAX_LENGTH = 2000
export const CSL_NAMES_MAX = 200
const NAME_PART_MAX_LENGTH = 300
/** Size of one stored entry (JSON); the Y.Map value is checked against it. */
export const CSL_ITEM_JSON_MAX_LENGTH = 32_000

/**
 * Citation keys: what Pandoc accepts after `@` (letters, digits, `_`, and
 * internal `:.#$%&-+?<>~/`), at most 100 characters, starting with a
 * letter, digit or `_`, not ending in punctuation.
 */
export const CITATION_KEY_RE = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&\-+?<>~/]*[\p{L}\p{N}_])?$/u
const CITATION_KEY_MAX_LENGTH = 100

export function isCitationKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= CITATION_KEY_MAX_LENGTH && CITATION_KEY_RE.test(key)
}

/** C0 control characters and DEL replaced by spaces. */
function withoutControlChars(v: string): string {
  let out = ''
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0
    out += c < 0x20 || c === 0x7F ? ' ' : ch
  }
  return out
}

function cleanText(v: unknown, max = CSL_TEXT_MAX_LENGTH): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return undefined
  // Control characters out, whitespace runs collapsed.
  const s = withoutControlChars(v).replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : undefined
}

function normalizeName(raw: unknown): CslName | null {
  if (typeof raw === 'string') {
    const literal = cleanText(raw, NAME_PART_MAX_LENGTH)
    return literal ? { literal } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name: CslName = {}
  for (const part of ['family', 'given', 'literal', 'non-dropping-particle', 'dropping-particle', 'suffix'] as const) {
    const v = cleanText(r[part], NAME_PART_MAX_LENGTH)
    if (v) name[part] = v
  }
  return name.family || name.literal || name.given ? name : null
}

function normalizeDate(raw: unknown): CslDate | undefined {
  if (typeof raw === 'string' || typeof raw === 'number') return parseDateString(String(raw))
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const parts = r['date-parts']
  if (Array.isArray(parts) && Array.isArray(parts[0])) {
    const first = (parts[0] as unknown[]).slice(0, 3).map(p => Number.parseInt(String(p), 10))
    const valid: number[] = []
    for (const p of first) {
      if (!Number.isFinite(p)) break
      valid.push(p)
    }
    if (valid.length > 0 && Math.abs(valid[0] ?? 0) < 10_000) return { 'date-parts': [valid] }
  }
  const literal = cleanText(r.literal ?? r.raw, 100)
  return literal ? (parseDateString(literal) ?? { literal }) : undefined
}

/** `2020`, `2020-05`, `2020-05-01`, `2020/05` → date-parts; anything else → literal. */
export function parseDateString(s: string): CslDate | undefined {
  const t = s.trim()
  if (!t) return undefined
  const m = /^(-?\d{1,4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?/.exec(t)
  if (m && (m[0].length === t.length || /^\d{4}-\d{2}-\d{2}T/.test(t))) {
    const parts = [Number(m[1]), m[2] ? Number(m[2]) : Number.NaN, m[3] ? Number(m[3]) : Number.NaN].filter(n => Number.isFinite(n))
    return { 'date-parts': [parts] }
  }
  return { literal: t.slice(0, 100) }
}

function nameList(raw: unknown): CslName[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, CSL_NAMES_MAX).map(normalizeName).filter((n): n is CslName => n !== null)
}

/** The known text, name and date fields of `r`, cleaned, onto `item`. */
function copyFields(r: Record<string, unknown>, item: CslItem): void {
  for (const f of CSL_TEXT_FIELDS) {
    const v = cleanText(r[f])
    if (v) item[f] = v
  }
  for (const f of CSL_NAME_FIELDS) {
    const names = nameList(r[f])
    if (names.length > 0) item[f] = names
  }
  for (const f of CSL_DATE_FIELDS) {
    const d = normalizeDate(r[f])
    if (d) item[f] = d
  }
}

/**
 * A CSL JSON entry reduced to known fields and bounded, or null when it
 * has no usable id or content. `id` falls back to `fallbackId`
 * (`citation-key`, Zotero's `id` for Better BibTeX exports).
 */
export function normalizeCslItem(raw: unknown, fallbackId?: string): CslItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = [r['citation-key'], r.id, fallbackId].map(v => (typeof v === 'number' ? String(v) : v)).find(isCitationKey)
  if (!id) return null
  const rawType = typeof r.type === 'string' ? r.type : ''
  const item: CslItem = { id, type: CSL_TYPES.has(rawType) ? rawType : 'document' }
  copyFields(r, item)
  if (item.DOI) item.DOI = item.DOI.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
  if (!item.title && !item.author && !item.editor && !item['container-title']) return null
  return item
}

/** Year of `issued`, or null. */
export function issuedYear(item: CslItem): number | null {
  const y = item.issued?.['date-parts']?.[0]?.[0]
  if (typeof y === 'number') return y
  const lit = /\d{4}/.exec(item.issued?.literal ?? '')
  return lit ? Number(lit[0]) : null
}

/** One-line plain description ("Smith, Jones 2020: Title") for pickers and hover. */
export function describeItem(item: CslItem): string {
  const names = (item.author ?? item.editor ?? []).slice(0, 3).map(n => n.family ?? n.literal ?? n.given ?? '').filter(Boolean)
  const who = names.length > 0 ? names.join(', ') + ((item.author ?? item.editor ?? []).length > 3 ? ' et al.' : '') : ''
  const year = issuedYear(item)
  const head = [who, year ?? ''].filter(Boolean).join(' ')
  return [head, item.title ?? item['container-title'] ?? ''].filter(Boolean).join(': ')
}

/** Parse a stored (Y.Map) value: a JSON string of one entry, keyed by its citation key. */
export function parseStoredItem(key: string, value: unknown): CslItem | null {
  if (typeof value !== 'string' || value.length > CSL_ITEM_JSON_MAX_LENGTH || !isCitationKey(key)) return null
  try {
    const item = normalizeCslItem(JSON.parse(value), key)
    return item ? { ...item, id: key } : null
  } catch {
    return null
  }
}

/** Entries of a stored bibliography (`[key, json]` pairs), validated, sorted by key, bounded. */
export function readStoredBibliography(entries: Iterable<[string, unknown]>): CslItem[] {
  const items: CslItem[] = []
  for (const [key, value] of entries) {
    const item = parseStoredItem(key, value)
    if (item) items.push(item)
    if (items.length >= BIBLIOGRAPHY_MAX_ENTRIES) break
  }
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The value written into the Y.Map for an entry. */
export function serializeItem(item: CslItem): string {
  return JSON.stringify(item)
}
