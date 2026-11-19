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

const LOCATOR_VALUE = /^[\dIVXLCDMivxlcdm]+[a-z]?(?:\s*[-–,&]\s*[\dIVXLCDMivxlcdm]+[a-z]?)*(?:\s*f{1,2}\.)?/

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
    return { locator: { label: label ?? 'page', value: value[0].replace(/\s*-\s*/g, '–') }, suffix: after }
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
    const at = m.index + m[1]!.length + m[2]!.length
    const key = readKey(part.slice(at + 1))
    if (!key) return null
    const prefix = part.slice(0, m.index + m[1]!.length).trim()
    const { locator, suffix } = parseSuffix(part.slice(at + 1 + key.length))
    refs.push({ key, prefix, suffix, ...(locator ? { locator } : {}), suppressAuthor: m[2] === '-' })
  }
  return refs.length > 0 ? refs : null
}

/** Character before a bare `@key` that allows it (start, space, opening punctuation): not an e-mail. */
export function bareCiteAllowedAfter(prev: string | undefined): boolean {
  return prev === undefined || prev === "" || /[\s([{"'\u201C\u2018\u00AB*_~]/.test(prev)
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
  const bracket = /\[([^\[\]\n]*@[^\[\]\n]*)\](?![([])/g
  const inBrackets = new Set<number>()
  for (const m of masked.matchAll(bracket)) {
    const refs = parseBracketCluster(m[1] ?? '')
    if (!refs) continue
    let from = (m.index ?? 0) + 1
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

/** Source with fenced code, inline code and `$…$` math blanked (same length, offsets kept). */
export function maskCode(source: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  return source
    .replace(/^(\s{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1?\2[^\n]*$|(?![\s\S]))/gm, blank)
    .replace(/(`+)[^`\n]+?\1/g, blank)
    .replace(/\$\$[\s\S]*?\$\$/g, blank)
    .replace(/(?<![\\$])\$(?=\S)[^$\n]+?(?<=\S)\$(?!\d)/g, blank)
}
