import { normalizeCslItem, parseDateString, type CslDate, type CslItem, type CslName } from './cslItem'

/**
 * BibTeX / BibLaTeX → CSL JSON. Covers what reference managers export
 * (Zotero, Better BibTeX, JabRef, Google Scholar, publisher pages):
 * `@type{key, field = {…} | "…" | 123 | macro # …}`, `@string`
 * macros, `@comment` / `@preamble` skipped, month macros, LaTeX accents
 * and the usual text commands converted to Unicode, `and`-separated
 * names in both `Last, First` and `First von Last` order, `{Protected
 * Corporate Names}` kept whole.
 *
 * Never throws: an entry that can't be read is counted in `skipped` and
 * the parser resumes at the next `@`. Input is bounded by the caller.
 */

export interface BibtexResult {
  items: CslItem[]
  /** Entries that were found but could not be turned into an item. */
  skipped: number
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}

const TYPE_MAP: Record<string, string> = {
  article: 'article-journal',
  book: 'book',
  mvbook: 'book',
  booklet: 'book',
  inbook: 'chapter',
  incollection: 'chapter',
  inreference: 'entry-encyclopedia',
  inproceedings: 'paper-conference',
  conference: 'paper-conference',
  proceedings: 'book',
  collection: 'book',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  thesis: 'thesis',
  techreport: 'report',
  report: 'report',
  manual: 'report',
  online: 'webpage',
  electronic: 'webpage',
  www: 'webpage',
  unpublished: 'manuscript',
  dataset: 'dataset',
  software: 'software',
  patent: 'patent',
  standard: 'standard',
  misc: 'document'
}

const ACCENTS: Record<string, string> = {
  '\'': '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄',
  '.': '̇', 'u': '̆', 'v': '̌', 'H': '̋', 'c': '̧', 'k': '̨',
  'r': '̊', 'd': '̣', 'b': '̱'
}

const SYMBOLS: Record<string, string> = {
  ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł',
  i: 'ı', j: 'ȷ', dh: 'ð', DH: 'Ð', th: 'þ', TH: 'Þ', ng: 'ŋ', NG: 'Ŋ',
  textendash: '–', textemdash: '\u2014', textquoteleft: '‘', textquoteright: '’',
  textquotedblleft: '“', textquotedblright: '”', ldots: '…', dots: '…',
  textellipsis: '…', S: '§', P: '¶', copyright: '©', textregistered: '®', texttrademark: '™',
  euro: '€', pounds: '£', textdegree: '°', LaTeX: 'LaTeX', TeX: 'TeX', textasciitilde: '~',
  textbackslash: '\\', textbar: '|', textless: '<', textgreater: '>'
}

/** Commands whose braced argument is kept as plain text. */
const TEXT_COMMANDS = new Set([
  'emph', 'textit', 'textbf', 'textsc', 'textrm', 'textsf', 'texttt', 'textup', 'textsl', 'textnormal',
  'mbox', 'text', 'url', 'href', 'mathrm', 'mathit', 'mathbf', 'enquote', 'NoCaseChange', 'MakeUppercase', 'uppercase'
])

class Reader {
  pos = 0
  constructor(readonly src: string) {}
  get done(): boolean { return this.pos >= this.src.length }
  peek(): string { return this.src[this.pos] ?? '' }
  skipSpace(): void {
    while (!this.done && /\s/.test(this.peek())) this.pos++
    // `%` comments inside entries (JabRef writes none, but hand-made files do).
    if (this.peek() === '%') {
      while (!this.done && this.peek() !== '\n') this.pos++
      this.skipSpace()
    }
  }

  ident(): string {
    const m = /^[^\s"#%'(),={}]+/.exec(this.src.slice(this.pos, this.pos + 200))
    if (!m) return ''
    this.pos += m[0].length
    return m[0]
  }

  /** Content of a `{…}` group starting at the current `{`, braces inside kept. */
  braced(): string {
    const start = ++this.pos
    let depth = 1
    while (!this.done) {
      const ch = this.src[this.pos]
      if (ch === '\\') {
        this.pos += 2
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) break
      this.pos++
    }
    if (this.done) throw new Error('unterminated brace')
    return this.src.slice(start, this.pos++)
  }

  quoted(): string {
    const start = ++this.pos
    let depth = 0
    while (!this.done) {
      const ch = this.src[this.pos]
      if (ch === '\\') {
        this.pos += 2
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '"' && depth === 0) break
      this.pos++
    }
    if (this.done) throw new Error('unterminated quote')
    return this.src.slice(start, this.pos++)
  }
}

/** A bare value word: a number, a `@string` macro, a month name, else the word itself. */
function bareWord(word: string, macros: Map<string, string>): string {
  if (/^\d+$/.test(word)) return word
  const lower = word.toLowerCase()
  const macro = macros.get(lower)
  if (macro !== undefined) return macro
  const month = MONTHS[lower.slice(0, 3)]
  return month && lower.length <= 9 ? String(month) : word
}

function readPart(r: Reader, macros: Map<string, string>): string {
  const ch = r.peek()
  if (ch === '{') return r.braced()
  if (ch === '"') return r.quoted()
  const word = r.ident()
  if (!word) throw new Error('expected a value')
  return bareWord(word, macros)
}

function readValue(r: Reader, macros: Map<string, string>): string {
  const parts: string[] = []
  for (;;) {
    r.skipSpace()
    parts.push(readPart(r, macros))
    r.skipSpace()
    if (r.peek() !== '#') return parts.join('')
    r.pos++
  }
}

/** Fields of one entry body, up to its closing delimiter. */
function readFields(r: Reader, close: string, macros: Map<string, string>): Map<string, string> {
  const fields = new Map<string, string>()
  for (;;) {
    r.skipSpace()
    if (r.peek() === close) {
      r.pos++
      return fields
    }
    if (r.peek() === ',') {
      r.pos++
      continue
    }
    const name = r.ident().toLowerCase()
    if (!name) throw new Error('expected a field name')
    r.skipSpace()
    if (r.peek() !== '=') throw new Error('expected =')
    r.pos++
    const value = readValue(r, macros)
    if (!fields.has(name)) fields.set(name, value)
  }
}

/** Skip to just after the balanced group that starts at the current `{` or `(`. */
function skipGroup(r: Reader): void {
  const open = r.peek()
  const close = open === '(' ? ')' : '}'
  let depth = 0
  while (!r.done) {
    const ch = r.src[r.pos++]
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return
  }
}

/**
 * LaTeX → Unicode for field values: accents (`\'e`, `{\"o}`, `\c{c}`),
 * symbols (`\ss`, `\o`), escaped specials (`\&`), text commands
 * (`\emph{x}` → x), `--` → en dash, `~` → no-break space; remaining
 * grouping braces removed. Unknown commands keep their argument.
 */
export function latexToUnicode(input: string): string {
  const accent = (m: string, acc: string, letter: string) => {
    const combining = ACCENTS[acc]
    return combining ? (letter.replace(/^\\([ij])$/, '$1') + combining).normalize('NFC') : m
  }
  // Accents: \'{e} / \c{c} / \'{\i}; then \'e / \"\i; then `\c c`. Wrapping
  // braces (`{\'e}`) go with the brace removal at the end.
  let s = input
    .replace(/\\([`'^"~=.uvHckrdb])\s*\{\s*(\\[ij]|[A-Za-z])\s*\}/g, accent)
    .replace(/\\([`'^"~=.])\s*(\\[ij](?![A-Za-z])|[A-Za-z])/g, accent)
    .replace(/\\([uvHckrdb])\s+([A-Za-z])(?![A-Za-z])/g, accent)
  // Named symbols: \ss, {\o}, \AE{}.
  s = s.replace(/\\([a-zA-Z]+)(?:\{\})?/g, (m, name: string) => SYMBOLS[name] ?? m)
  // Text commands: \emph{x} → x (innermost first, repeated for nesting).
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\])?\{([^{}]*)\}/g, (m, name: string, arg: string) =>
      TEXT_COMMANDS.has(name) || !SYMBOLS[name] ? arg : m)
    if (next === s) break
    s = next
  }
  s = s
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\\\/g, ' ')
    .replace(/---/g, '\u2014')
    .replace(/--/g, '–')
    .replace(/~/g, '\u00A0')
    .replace(/``|''/g, '"')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}]/g, '')
  return s.replace(/\s+/g, ' ').trim()
}

/** Split on ` and ` at brace depth 0. */
function splitNames(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (depth === 0 && /\s/.test(ch ?? '') && /^\s+and\s+/i.test(value.slice(i, i + 8))) {
      const m = /^\s+and\s+/i.exec(value.slice(i))
      out.push(value.slice(start, i))
      i += (m?.[0].length ?? 1) - 1
      start = i + 1
    }
  }
  out.push(value.slice(start))
  return out.map(n => n.trim()).filter(Boolean)
}

/** Split at commas on brace depth 0. */
function splitTopLevel(value: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (depth === 0 && ch === sep) {
      out.push(value.slice(start, i))
      start = i + 1
    }
  }
  out.push(value.slice(start))
  return out.map(p => p.trim())
}

function words(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

function isLowerWord(w: string): boolean {
  const first = /[\p{L}]/u.exec(latexToUnicode(w))?.[0] ?? ''
  return !w.startsWith('{') && first !== '' && first === first.toLowerCase() && first !== first.toUpperCase()
}

/** One BibTeX name → CSL name. */
export function parseBibtexName(raw: string): CslName | null {
  const name = raw.trim()
  if (!name) return null
  // `{World Health Organization}`: a corporate name, kept whole.
  if (/^\{[^{}]*\}$/.test(name) || (name.startsWith('{') && name.endsWith('}') && splitTopLevel(name, ',').length === 1 && words(name).length === 1)) {
    return { literal: latexToUnicode(name) }
  }
  const commaParts = splitTopLevel(name, ',')
  return commaParts.length >= 2 ? invertedName(commaParts) : firstVonLast(name)
}

const cleanPart = (s: string | undefined) => (s ? latexToUnicode(s) : '')

/** `von Last, Jr, First` | `von Last, First`. */
function invertedName(commaParts: string[]): CslName | null {
  const lastWords = words(commaParts[0] ?? '')
  const particle = lastWords.filter((w, i) => i < lastWords.length - 1 && isLowerWord(w))
  const family = lastWords.slice(particle.length).join(' ')
  const given = commaParts.length >= 3 ? commaParts.slice(2).join(', ') : commaParts[1]
  const out: CslName = { family: cleanPart(family), given: cleanPart(given) }
  if (particle.length > 0) out['non-dropping-particle'] = cleanPart(particle.join(' '))
  if (commaParts.length >= 3 && commaParts[1]) out.suffix = cleanPart(commaParts[1])
  return out.family ? trimName(out) : null
}

/** `First von Last`. */
function firstVonLast(name: string): CslName {
  const clean = cleanPart
  const ws = words(name)
  if (ws.length === 1) return { family: clean(ws[0]) }
  const vonStart = ws.findIndex((w, i) => i > 0 && i < ws.length - 1 && isLowerWord(w))
  if (vonStart > 0) {
    let vonEnd = vonStart
    while (vonEnd + 1 < ws.length - 1 && isLowerWord(ws[vonEnd + 1] ?? '')) vonEnd++
    return trimName({
      'given': clean(ws.slice(0, vonStart).join(' ')),
      'non-dropping-particle': clean(ws.slice(vonStart, vonEnd + 1).join(' ')),
      'family': clean(ws.slice(vonEnd + 1).join(' '))
    })
  }
  return trimName({ given: clean(ws.slice(0, -1).join(' ')), family: clean(ws.at(-1)) })
}

function trimName(n: CslName): CslName {
  const out: CslName = {}
  for (const [k, v] of Object.entries(n) as Array<[keyof CslName, string | undefined]>) {
    if (v) out[k] = v
  }
  return out
}

function bibDate(fields: Map<string, string>, dateField: string, prefix = ''): CslDate | undefined {
  const date = fields.get(dateField)
  if (date) return parseDateString(latexToUnicode(date).split('/')[0] ?? '')
  const year = /-?\d{1,4}/.exec(latexToUnicode(fields.get(`${prefix}year`) ?? ''))?.[0]
  if (!year) return undefined
  const parts = [Number(year)]
  const monthRaw = latexToUnicode(fields.get(`${prefix}month`) ?? '').toLowerCase()
  const month = /^\d+$/.test(monthRaw) ? Number(monthRaw) : MONTHS[monthRaw.slice(0, 3)]
  if (month && month >= 1 && month <= 12) {
    parts.push(month)
    const day = Number(latexToUnicode(fields.get(`${prefix}day`) ?? ''))
    if (day >= 1 && day <= 31) parts.push(day)
  }
  return { 'date-parts': [parts] }
}

/** One parsed entry → CSL item (before normalisation). */
function toCsl(type: string, key: string, fields: Map<string, string>): Record<string, unknown> {
  const text = (name: string) => {
    const v = fields.get(name)
    return v === undefined ? undefined : latexToUnicode(v)
  }
  const cslType = TYPE_MAP[type] ?? 'document'
  const out: Record<string, unknown> = { id: key, type: cslType }
  const set = (field: string, value: string | undefined) => {
    if (value) out[field] = value
  }
  set('title', text('title'))
  set('title-short', text('shorttitle'))
  const container = text('journaltitle') ?? text('journal') ?? text('booktitle') ?? (cslType === 'webpage' ? text('organization') : undefined)
  set('container-title', container)
  set('container-title-short', text('shortjournal'))
  set('collection-title', text('series'))
  set('publisher', text('publisher') ?? text('school') ?? text('institution') ?? (cslType === 'webpage' ? undefined : text('organization')))
  set('publisher-place', text('location') ?? text('address'))
  set('event-title', text('eventtitle'))
  set('volume', text('volume'))
  if (cslType === 'article-journal' || cslType === 'article-magazine') set('issue', text('number') ?? text('issue'))
  else {
    set('number', text('number'))
    set('issue', text('issue'))
  }
  set('page', text('pages')?.split(/[-–]+/).map(p => p.trim()).join('-'))
  set('edition', text('edition'))
  set('DOI', text('doi'))
  set('URL', text('url') ?? (text('howpublished')?.startsWith('http') ? text('howpublished') : undefined))
  set('ISBN', text('isbn'))
  set('ISSN', text('issn'))
  set('note', text('note') ?? text('addendum'))
  set('language', text('langid') ?? text('language'))
  set('version', text('version'))
  const genre = text('type') ?? (type === 'phdthesis' ? 'PhD thesis' : type === 'mastersthesis' ? 'Master\'s thesis' : undefined)
  set('genre', genre)
  for (const role of ['author', 'editor', 'translator'] as const) {
    const v = fields.get(role)
    if (v) out[role] = splitNames(v).map(parseBibtexName).filter((n): n is CslName => n !== null)
  }
  const issued = bibDate(fields, 'date')
  if (issued) out.issued = issued
  const accessed = bibDate(fields, 'urldate', 'url')
  if (accessed && fields.has('urldate')) out.accessed = accessed
  return out
}

/**
 * The entry body after `@type`, at its opening delimiter: the item, null
 * for an unusable entry, undefined for a `@string` definition (stored in
 * `macros`). Throws on a syntax error.
 */
function readEntry(r: Reader, type: string, close: string, macros: Map<string, string>): CslItem | null | undefined {
  r.pos++
  if (type === 'string') {
    for (const [k, v] of readFields(r, close, macros)) macros.set(k, v)
    return undefined
  }
  r.skipSpace()
  const keyMatch = /^[^,\s{}()]*/.exec(r.src.slice(r.pos, r.pos + 300))
  const key = keyMatch?.[0] ?? ''
  r.pos += key.length
  r.skipSpace()
  if (r.peek() === ',') r.pos++
  const fields = readFields(r, close, macros)
  return normalizeCslItem(toCsl(type, key, fields))
}

export function parseBibtex(src: string): BibtexResult {
  const r = new Reader(src)
  const macros = new Map<string, string>()
  const items: CslItem[] = []
  let skipped = 0
  while (!r.done) {
    const at = src.indexOf('@', r.pos)
    if (at < 0) break
    r.pos = at + 1
    const type = r.ident().toLowerCase()
    r.skipSpace()
    const open = r.peek()
    if (!type || (open !== '{' && open !== '(')) continue
    if (type === 'comment' || type === 'preamble') {
      skipGroup(r)
      continue
    }
    const entryStart = r.pos
    try {
      const item = readEntry(r, type, open === '(' ? ')' : '}', macros)
      if (item) items.push(item)
      else if (item === null) skipped++
    } catch {
      skipped++
      r.pos = entryStart + 1
    }
  }
  return { items, skipped }
}
