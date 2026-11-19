/**
 * Pandoc citation syntax, shared by the markdown-it rule (rendering), the
 * editor (autocomplete, hover) and the server (AI citation checks):
 *
 *   [@smith2020]                 parenthetical
 *   [@smith2020, p. 12]          with a locator
 *   [see @smith2020, ch. 3; @jones2019]   prefix, several sources
 *   [-@smith2020]                year only ("Smith says (2020)")
 *   @smith2020                   narrative ("Smith (2020)")
 *   @smith2020 [p. 12]           narrative with a locator
 *
 * Cross-references use the same syntax with a label prefix: `@fig:x`,
 * `[@tbl:y]`, `@eq:z`, `@sec:w` (pandoc-crossref).
 */

export type LocatorLabel = 'page' | 'chapter' | 'section' | 'paragraph' | 'figure' | 'volume' | 'line' | 'note' | 'column'

export interface Locator {
  label: LocatorLabel
  value: string
}

export interface CiteRef {
  key: string
  prefix: string
  suffix: string
  locator?: Locator
  suppressAuthor: boolean
}

export const CROSSREF_KINDS = ['fig', 'tbl', 'eq', 'sec'] as const
export type CrossrefKind = typeof CROSSREF_KINDS[number]

/** `fig:overview` → `fig`; a citation key → null. */
export function crossrefKind(key: string): CrossrefKind | null {
  const m = /^(fig|tbl|eq|sec):./.exec(key)
  return m ? (m[1] as CrossrefKind) : null
}

/** A key starting at the beginning of `s` (Pandoc rules: internal punctuation only). */
const KEY_AT_START = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&\-+?<>~/]*[\p{L}\p{N}_])?/u

export function readKey(s: string): string | null {
  const m = KEY_AT_START.exec(s)
  return m && m[0].length <= 100 ? m[0] : null
}

const LOCATOR_TERMS: ReadonlyArray<[RegExp, LocatorLabel]> = [
  [/^(?:pp?\.|pages?|S\.|Seiten?|pg\.)/i, 'page'],
  [/^(?:chap\.|chaps\.|ch\.|chapters?|Kap\.|Kapitel|chapitre)/i, 'chapter'],
  [/^(?:sec\.|secs\.|sections?|§§?|Abschn\.|Abschnitt)/i, 'section'],
  [/^(?:para\.|paras\.|paragraphs?|¶|Abs\.)/i, 'paragraph'],
  [/^(?:fig\.|figs\.|figures?|Abb\.)/i, 'figure'],
  [/^(?:vol\.|vols\.|volumes?|Bd\.)/i, 'volume'],
  [/^(?:ll?\.|lines?|Z\.)/i, 'line'],
  [/^(?:nn?\.|notes?|Anm\.|Fn\.)/i, 'note'],
  [/^(?:col\.|cols\.|columns?|Sp\.)/i, 'column']
]

const LOCATOR_VALUE = /^[\dIVXLCDMivxlcdm]+(?:[-\u2013,&][\dIVXLCDMivxlcdm]+)*(?: ?f{1,2}\.)?/

/** `, p. 12, emphasis added` → locator `page 12` + suffix `emphasis added`. */
export function parseSuffix(raw: string): { locator?: Locator, suffix: string } {
  let rest = raw.trim().replace(/^,\s*/, '')
  if (!rest) return { suffix: '' }
  let label: LocatorLabel | null = null
  for (const [re, l] of LOCATOR_TERMS) {
    const m = re.exec(rest)
    if (m) {
      label = l
      rest = rest.slice(m[0].length).trimStart()
      break
    }
  }
  const value = LOCATOR_VALUE.exec(rest)
  // A bare number is a page; a label without a value is ordinary text.
  if (value && (label || /^\d/.test(rest))) {
    const after = rest.slice(value[0].length).trim().replace(/^,\s*/, '')
    return { locator: { label: label ?? 'page', value: value[0].replace(/-/g, '–') }, suffix: after }
  }
  return { suffix: raw.trim().replace(/^,\s*/, '') }
}

/** Split on `;` outside quotes / brackets. */
function splitItems(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth--
    else if (ch === ';' && depth === 0) {
      out.push(inner.slice(start, i))
      start = i + 1
    }
  }
  out.push(inner.slice(start))
  return out
}

/**
 * The content of `[…]` as a citation cluster, or null when it isn't one
 * (every `;`-separated part needs exactly one `@key`, so `[an @mention]`
 * of a non-key and ordinary bracketed text stay text).
 */
export function parseBracketCluster(inner: string): CiteRef[] | null {
  if (!inner.includes('@') || inner.length > 2000) return null
  const refs: CiteRef[] = []
  for (const part of splitItems(inner)) {
    const m = /(^|[\s([{"'“‘])(-?)@/.exec(part)
    if (!m) return null
    const lead = m[1] ?? ''
    const dash = m[2] ?? ''
    const at = m.index + lead.length + dash.length
    const key = readKey(part.slice(at + 1))
    if (!key) return null
    const prefix = part.slice(0, m.index + lead.length).trim()
    const { locator, suffix } = parseSuffix(part.slice(at + 1 + key.length))
    refs.push({ key, prefix, suffix, ...(locator ? { locator } : {}), suppressAuthor: dash === '-' })
  }
  return refs.length > 0 ? refs : null
}

/** Character before a bare `@key` that allows it (start, space, opening punctuation): not an e-mail. */
export function bareCiteAllowedAfter(prev: string | undefined): boolean {
  return prev === undefined || prev === '' || /[\s([{"'\u201C\u2018\u00AB*_~]/.test(prev)
}

export interface CitationOccurrence {
  key: string
  /** Offset of the `@` in the source. */
  index: number
  bracketed: boolean
}

/**
 * Every `@key` in Markdown source that the renderer would read as a
 * citation or cross-reference candidate, outside fenced code, inline
 * code and math. Used for checks (the AI's grounded citing, warnings),
 * not for rendering: bare `@word`s are reported too, the caller decides
 * (a bare key that isn't in the bibliography stays text).
 */
export function findCitations(source: string): CitationOccurrence[] {
  const masked = maskCode(source)
  const out: CitationOccurrence[] = []
  const inBrackets = new Set<number>()
  for (const group of bracketGroups(masked)) {
    const refs = parseBracketCluster(group.inner)
    if (!refs) continue
    let from = group.start + 1
    for (const ref of refs) {
      const at = masked.indexOf(`@${ref.key}`, from)
      if (at < 0) continue
      inBrackets.add(at)
      out.push({ key: ref.key, index: at, bracketed: true })
      from = at + ref.key.length
    }
  }
  for (const m of masked.matchAll(/@/g)) {
    const at = m.index ?? 0
    if (inBrackets.has(at) || !bareCiteAllowedAfter(masked[at - 1])) continue
    const key = readKey(masked.slice(at + 1))
    if (key) out.push({ key, index: at, bracketed: false })
  }
  return out.sort((a, b) => a.index - b.index)
}

/**
 * `[…]` groups on one line, without nested brackets, that contain an `@`
 * and are not followed by `(` or `[` (links): what the renderer may read
 * as a citation cluster.
 */
function bracketGroups(src: string): Array<{ start: number, inner: string }> {
  const out: Array<{ start: number, inner: string }> = []
  let open = -1
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '[') open = i
    else if (ch === '\n') open = -1
    else if (ch === ']' && open >= 0) {
      const inner = src.slice(open + 1, i)
      const next = src[i + 1]
      if (inner.includes('@') && next !== '(' && next !== '[') out.push({ start: open, inner })
      open = -1
    }
  }
  return out
}

/** Blank `[from, to)` of `chars`, keeping newlines. */
function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to && i < chars.length; i++) {
    if (chars[i] !== '\n') chars[i] = ' '
  }
}

/** The fence marker (```` ``` ```` / `~~~`, 3+) opening a line indented at most 3 spaces, or null. */
function fenceMarker(line: string): string | null {
  const indent = line.length - line.trimStart().length
  if (indent > 3) return null
  const rest = line.slice(indent)
  const ch = rest[0]
  if (ch !== '`' && ch !== '~') return null
  let n = 0
  while (rest[n] === ch) n++
  return n >= 3 ? ch.repeat(n) : null
}

/** Fenced code blocks, from the opening to the closing fence line (or the end). */
function maskFences(chars: string[], source: string): void {
  let offset = 0
  let openAt = -1
  let marker = ''
  for (const line of source.split('\n')) {
    const fence = fenceMarker(line)
    if (openAt < 0 && fence) {
      openAt = offset
      marker = fence
    } else if (openAt >= 0 && fence?.startsWith(marker)) {
      blank(chars, openAt, offset + line.length)
      openAt = -1
    }
    offset += line.length + 1
  }
  if (openAt >= 0) blank(chars, openAt, source.length)
}

/** Length of the run of `ch` starting at `i`. */
function runLength(s: string, i: number, ch: string): number {
  let n = 0
  while (s[i + n] === ch) n++
  return n
}

/** Inline code spans on one line (a backtick run closed by an equal run). */
function maskInlineCode(chars: string[], s: string): void {
  let i = 0
  while (i < s.length) {
    if (s[i] !== '`') {
      i++
      continue
    }
    const n = runLength(s, i, '`')
    const lineEnd = s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i)
    const close = s.slice(i + n, lineEnd).indexOf('`'.repeat(n))
    if (close > 0) {
      const end = i + n + close + n
      blank(chars, i, end)
      i = end
    } else {
      i += n
    }
  }
}

/** `$$ … $$` display math (across lines). */
function maskDisplayMath(chars: string[], s: string): void {
  let from = s.indexOf('$$')
  while (from >= 0) {
    const close = s.indexOf('$$', from + 2)
    if (close < 0) return
    blank(chars, from, close + 2)
    from = s.indexOf('$$', close + 2)
  }
}

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch)

/** `$x$` inline math: no space inside the delimiters, not followed by a digit (`$5`). */
function maskInlineMath(chars: string[], s: string): void {
  let i = 0
  while (i < s.length) {
    const opens = s[i] === '$' && s[i - 1] !== '\\' && s[i - 1] !== '$' && s[i + 1] !== '$' && !isSpace(s[i + 1])
    let j = i + 1
    if (opens) {
      while (j < s.length && s[j] !== '$' && s[j] !== '\n') j++
      if (s[j] === '$' && !isSpace(s[j - 1]) && !/\d/.test(s[j + 1] ?? '')) {
        blank(chars, i, j + 1)
        i = j + 1
        continue
      }
    }
    i++
  }
}

/** Source with fenced code, inline code and `$…$` math blanked (same length, offsets kept). */
export function maskCode(source: string): string {
  // UTF-16 code units, like the offsets callers use.
  const chars = source.split('')
  maskFences(chars, source)
  let s = chars.join('')
  maskInlineCode(chars, s)
  s = chars.join('')
  maskDisplayMath(chars, s)
  s = chars.join('')
  maskInlineMath(chars, s)
  return chars.join('')
}
