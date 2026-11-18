import { diffWordsWithSpace } from 'diff'
import { countPlaceholders, placeholderToken, stripPlaceholders } from './mask'
import type { JobMode } from './units'
import { EM_DASH, filterEmDashes } from '../dashFilter'
import type { GlossaryEntry } from './workerPrompt'

// Deterministic checks of one worker answer before it is applied. Every
// problem has a machine code and a sentence that goes back to the worker
// as retry feedback. The checks run on the MASKED texts: everything the
// worker must not touch is a placeholder there, so any link, URL, image,
// HTML tag or file reference in the answer is new. Pure (explicit imports
// only), so an eval harness can import it.

export type ValidationCode
  = | 'empty'
    | 'wrapped_in_fence'
    | 'chat_preface'
    | 'em_dash'
    | 'placeholder_missing'
    | 'placeholder_repeated'
    | 'placeholder_unknown'
    | 'new_link'
    | 'new_url'
    | 'new_image'
    | 'new_file_ref'
    | 'new_html'
    | 'new_mention'
    | 'heading_structure'
    | 'table_columns'
    | 'fence_unbalanced'
    | 'length_ratio'
    | 'untranslated'
    | 'terminology_spread'
    | 'invalid_json'
    | 'invalid_finding'
    | 'quote_not_found'

export interface ValidationProblem {
  code: ValidationCode
  message: string
}

export interface ValidationResult {
  ok: boolean
  problems: ValidationProblem[]
}

export interface ValidationInput {
  mode: JobMode
  /** The masked unit text the worker received. */
  source: string
  /** The worker's answer (still masked). */
  output: string
  /** Number of placeholders in `source` (`⟦P1⟧` … `⟦Pn⟧`). */
  placeholderCount: number
  glossary?: readonly GlossaryEntry[]
  /** translate: the language the answer must be in (name or ISO code). */
  targetLanguage?: string | null
  /** Overrides the mode's length band (e.g. "shorten by 30 %"). */
  lengthBand?: { min: number, max: number } | null
}

export interface CommentFinding {
  quote: string
  issue: string
  suggestion?: string
  severity: 'low' | 'medium' | 'high'
}

export interface ScanItem {
  text: string
  example?: string
}

/** Default length bands (answer prose length / unit prose length). */
const LENGTH_BANDS: Partial<Record<JobMode, { min: number, max: number }>> = {
  translate: { min: 0.6, max: 1.6 },
  rewrite: { min: 0.75, max: 1.3 },
  terminology: { min: 0.85, max: 1.2 }
}

/** Below this many prose characters the length ratio says nothing. */
const LENGTH_CHECK_MIN_CHARS = 200
/** Changed characters allowed outside glossary sentences in terminology mode. */
const TERMINOLOGY_SPREAD_MAX = 0.05
const MAX_FINDINGS = 20
const MAX_SCAN_ITEMS = 300

// Chat prefaces and sign-offs in the languages markoto documents are mostly
// written in (phrase lists, not one large regex: cheap and easy to extend).
const PREFACES = [
  'here\'s', 'here is', 'here are', 'sure', 'certainly', 'of course', 'absolutely', 'okay', 'ok,', 'below is',
  'i\'ve rewritten', 'i\'ve translated', 'i have rewritten', 'i have translated', 'i have revised',
  'hier ist', 'hier sind', 'gerne', 'natürlich', 'selbstverständlich', 'nachfolgend',
  'voici', 'bien sûr', 'certainement', 'aquí está', 'aquí tienes', 'claro', 'por supuesto',
  'ecco', 'certo', 'certamente'
]
const SIGNOFFS = [
  'i hope this helps', 'i hope that helps', 'let me know if', 'feel free to', 'ich hoffe, das hilft', 'ich hoffe das hilft',
  'ich hoffe, dies hilft', 'lass mich wissen', 'lassen sie mich wissen', 'j\'espère que cela', 'n\'hésitez pas',
  'espero que esto ayude', 'espero que te ayude', 'spero che questo', 'spero che ti'
]

/** Whether `text` starts with one of `phrases` as whole words (case-insensitive). */
function startsWithPhrase(text: string, phrases: readonly string[]): boolean {
  const t = text.trimStart().toLowerCase()
  return phrases.some(p => t.startsWith(p) && !/[\p{L}\p{N}]/u.test(t[p.length] ?? ''))
}

/** Whether the last line of `text` contains one of `phrases`. */
function endsWithPhrase(text: string, phrases: readonly string[]): boolean {
  const last = (text.trimEnd().split('\n').at(-1) ?? '').toLowerCase()
  return phrases.some(p => last.includes(p))
}

const LINK_TARGET_RE = /\]\(([^)\n]*)\)/g
const URL_RE = /\b(?:https?:\/\/|www\.|mailto:)[^\s<>)]+/g
const AUTOLINK_RE = /<[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>/g
const IMAGE_RE = /!\[/g
const HTML_TAG_RE = /<\/?[A-Za-z][^<>\n]{0,500}>/g
const MENTION_RE = /(?<![\w@.])@[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,60}/gu
const FENCE_LINE_RE = /^ {0,3}(?:`{3,}|~{3,})/gm

function count(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length
}

function problem(code: ValidationCode, message: string): ValidationProblem {
  return { code, message }
}

// ── structure ──────────────────────────────────────────────────────────

/** The fence a line opens or closes (` ``` ` / `~~~`), or null. */
function fenceOf(line: string): string | null {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null
}

/** The open fence after a fence line `f` (opens one, closes the matching one, or is code inside it). */
function nextFence(open: string | null, f: string): string | null {
  if (open === null) return f
  return f[0] === open[0] && f.length >= open.length ? null : open
}

/** Level of a setext heading whose text is line `i`, or 0. */
function setextLevel(lines: readonly string[], i: number): number {
  const line = lines[i] ?? ''
  const next = lines[i + 1] ?? ''
  const prev = i > 0 ? lines[i - 1] ?? '' : ''
  const isText = line.trim() !== '' && prev.trim() === '' && !/^ {0,3}(?:[-*+>|]|\d+[.)])/.test(line)
  if (!isText || !/^ {0,3}(?:=+|-{2,})[ \t]*$/.test(next)) return 0
  return next.trim().startsWith('=') ? 1 : 2
}

/** Heading levels in order (ATX and setext), outside fenced code. */
function headingLevels(text: string): number[] {
  const lines = text.split('\n')
  const levels: number[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const f = fenceOf(line)
    if (f) {
      fence = nextFence(fence, f)
    } else if (fence === null) {
      const atx = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line)?.[1]
      const setext = atx ? 0 : setextLevel(lines, i)
      if (atx) levels.push(atx.length)
      else if (setext > 0) {
        levels.push(setext)
        i++
      }
    }
  }
  return levels
}

/** A table delimiter row: cells of dashes with optional colons (`| --- | :-: |`). */
function isDelimiterRow(line: string): boolean {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c.trim()))
}

/** Column count of each table (from its header row), in order. */
function tableColumnCounts(text: string): number[] {
  const lines = text.split('\n')
  const counts: number[] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i] ?? ''
    const delim = lines[i + 1] ?? ''
    if (!header.includes('|') || !isDelimiterRow(delim)) continue
    const cells = header.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    counts.push(cells.length)
    i++
  }
  return counts
}

function checkStructure(input: ValidationInput, out: ValidationProblem[]): void {
  if (input.mode !== 'summarise') {
    const before = headingLevels(input.source)
    const after = headingLevels(input.output)
    if (before.join(',') !== after.join(',')) {
      out.push(problem('heading_structure', `The headings changed: the unit has ${before.length} heading(s) with levels [${before.join(', ')}], your answer has ${after.length} with levels [${after.join(', ')}]. Keep every heading at its level.`))
    }
    const tablesBefore = tableColumnCounts(input.source)
    const tablesAfter = tableColumnCounts(input.output)
    if (tablesBefore.join(',') !== tablesAfter.join(',')) {
      out.push(problem('table_columns', `The tables changed: column counts were [${tablesBefore.join(', ')}], now [${tablesAfter.join(', ')}]. Keep every table and its columns.`))
    }
  }
  if (count(input.output, FENCE_LINE_RE) % 2 !== 0) {
    out.push(problem('fence_unbalanced', 'A code fence (```) is opened but not closed.'))
  }
}

// ── placeholders and new content ───────────────────────────────────────

function checkPlaceholders(input: ValidationInput, out: ValidationProblem[]): void {
  const counts = countPlaceholders(input.output)
  for (let n = 1; n <= input.placeholderCount; n++) {
    const c = counts.get(n) ?? 0
    if (c === 0) out.push(problem('placeholder_missing', `Placeholder ${placeholderToken(n)} is missing.`))
    else if (c > 1) out.push(problem('placeholder_repeated', `Placeholder ${placeholderToken(n)} appears ${c} times; it must appear exactly once.`))
  }
  for (const n of counts.keys()) {
    if (n < 1 || n > input.placeholderCount) out.push(problem('placeholder_unknown', `Placeholder ${placeholderToken(n)} does not exist in the unit; remove it.`))
  }
}

function linkTargetsNotPlaceholders(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(LINK_TARGET_RE)) {
    const target = (m[1] ?? '').trim()
    if (!/^⟦P\d{1,5}⟧$/.test(target)) out.push(target)
  }
  return out
}

function newOnes(sourceItems: readonly string[], outputItems: readonly string[]): string[] {
  const left = new Map<string, number>()
  for (const s of sourceItems) left.set(s, (left.get(s) ?? 0) + 1)
  const fresh: string[] = []
  for (const o of outputItems) {
    const n = left.get(o) ?? 0
    if (n > 0) left.set(o, n - 1)
    else fresh.push(o)
  }
  return fresh
}

function matches(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map(m => m[0])
}

function checkNewContent(input: ValidationInput, out: ValidationProblem[]): void {
  const { source, output } = input
  const links = newOnes(linkTargetsNotPlaceholders(source), linkTargetsNotPlaceholders(output))
  if (links.length > 0) out.push(problem('new_link', `Your answer adds link target(s) that are not in the unit (${links.slice(0, 3).join(', ')}). Do not add links.`))
  const urlsOf = (t: string) => [...matches(t, URL_RE), ...matches(t, AUTOLINK_RE)]
  const urls = newOnes(urlsOf(source), urlsOf(output))
  if (urls.length > 0) out.push(problem('new_url', `Your answer adds URL(s) that are not in the unit (${urls.slice(0, 3).join(', ')}). Do not add URLs.`))
  if (count(output, IMAGE_RE) > count(source, IMAGE_RE)) out.push(problem('new_image', 'Your answer adds an image. Do not add images.'))
  if (count(output, /\/api\/files\//g) > count(source, /\/api\/files\//g)) out.push(problem('new_file_ref', 'Your answer adds a file reference (/api/files/...). Do not add file references.'))
  const tags = newOnes(matches(source, HTML_TAG_RE), matches(output, HTML_TAG_RE))
  if (tags.length > 0) out.push(problem('new_html', `Your answer adds HTML (${tags.slice(0, 3).join(' ')}). Do not add HTML.`))
  const mentions = newOnes(matches(source, MENTION_RE).map(m => m.toLowerCase()), matches(output, MENTION_RE).map(m => m.toLowerCase()))
  if (mentions.length > 0) out.push(problem('new_mention', `Your answer adds @-mention(s) (${mentions.slice(0, 3).join(', ')}). Do not add mentions.`))
}

// ── form ────────────────────────────────────────────────────────────────

/** The whole answer is one fenced block (first and last line are fences). */
function wrappedInFence(trimmed: string): boolean {
  const lines = trimmed.split('\n')
  const fence = (l: string | undefined) => /^(?:`{3}|~{3})/.test(l ?? '')
  return lines.length >= 2 && fence(lines[0]) && fence(lines.at(-1))
}

function checkForm(input: ValidationInput, out: ValidationProblem[]): void {
  const { source, output } = input
  const trimmed = output.trim()
  if (wrappedInFence(trimmed) && !/^(?:`{3}|~{3})/.test(source.trim())) {
    out.push(problem('wrapped_in_fence', 'Your answer is wrapped in a code fence. Return the Markdown itself, without a fence around it.'))
  }
  if (startsWithPhrase(trimmed, PREFACES) && !startsWithPhrase(source, PREFACES)) {
    out.push(problem('chat_preface', 'Your answer starts with a preface ("Here is ..."). Return only the transformed text.'))
  } else if (endsWithPhrase(trimmed, SIGNOFFS) && !endsWithPhrase(source, SIGNOFFS)) {
    out.push(problem('chat_preface', 'Your answer ends with a comment to the reader ("I hope this helps", ...). Return only the transformed text.'))
  }
  const dashesOut = output.split(EM_DASH).length - 1
  const dashesIn = source.split(EM_DASH).length - 1
  const allowed = input.mode === 'terminology' ? dashesIn : 0
  if (dashesOut > allowed) out.push(problem('em_dash', 'Your answer contains the em-dash character (U+2014). Use a comma, colon, parentheses or a new sentence instead.'))
}

function checkLength(input: ValidationInput, out: ValidationProblem[]): void {
  const band = input.lengthBand ?? LENGTH_BANDS[input.mode]
  if (!band) return
  const before = stripPlaceholders(input.source).trim().length
  if (before < LENGTH_CHECK_MIN_CHARS) return
  const after = stripPlaceholders(input.output).trim().length
  const ratio = after / before
  if (ratio < band.min || ratio > band.max) {
    out.push(problem('length_ratio', `Your answer is ${Math.round(ratio * 100)} % of the unit's length; this job expects ${Math.round(band.min * 100)}-${Math.round(band.max * 100)} %. ${ratio < band.min ? 'Do not leave anything out.' : 'Do not add content.'}`))
  }
}

// ── language ────────────────────────────────────────────────────────────

const STOPWORDS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'with', 'as', 'on', 'are', 'be', 'this', 'by', 'not', 'or', 'from', 'which', 'an', 'was', 'have', 'has', 'will', 'can', 'we', 'you', 'they', 'if'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'den', 'dem', 'ein', 'eine', 'einen', 'zu', 'von', 'auf', 'für', 'sich', 'des', 'auch', 'werden', 'wird', 'sind', 'oder', 'im', 'bei', 'wir', 'sie', 'es', 'dass', 'nach'],
  fr: ['le', 'la', 'les', 'et', 'des', 'est', 'une', 'un', 'du', 'que', 'qui', 'dans', 'pour', 'pas', 'sur', 'au', 'avec', 'ce', 'il', 'elle', 'sont', 'par', 'nous', 'vous', 'mais', 'ou', 'se', 'aux', 'leur', 'cette'],
  es: ['el', 'la', 'los', 'las', 'y', 'de', 'que', 'en', 'es', 'un', 'una', 'por', 'con', 'para', 'del', 'se', 'no', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'su', 'son', 'está', 'este', 'esta', 'entre', 'cuando'],
  it: ['il', 'lo', 'gli', 'e', 'di', 'che', 'è', 'per', 'un', 'una', 'del', 'della', 'non', 'con', 'si', 'sono', 'nel', 'nella', 'alla', 'come', 'ma', 'anche', 'dei', 'delle', 'questo', 'questa', 'ha', 'più', 'tra']
}

const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en',
  englisch: 'en',
  anglais: 'en',
  german: 'de',
  deutsch: 'de',
  allemand: 'de',
  french: 'fr',
  französisch: 'fr',
  francais: 'fr',
  français: 'fr',
  spanish: 'es',
  spanisch: 'es',
  español: 'es',
  espanol: 'es',
  italian: 'it',
  italienisch: 'it',
  italiano: 'it'
}

/** ISO 639-1 code of a language name or tag we have stopwords for ("English", "de-CH", "fr"), else null. */
export function languageCode(language: string | null | undefined): string | null {
  if (!language) return null
  const raw = language.trim().toLowerCase()
  const code = raw.split(/[-_ ]/)[0] ?? ''
  if (code in STOPWORDS) return code
  return LANGUAGE_NAMES[raw] ?? LANGUAGE_NAMES[code] ?? null
}

const WORD_RE = /[\p{L}]+/gu

/** Stopword hits per language for one text. */
function stopwordScores(text: string): Record<string, number> {
  const words = (text.toLowerCase().match(WORD_RE) ?? [])
  const scores: Record<string, number> = {}
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list)
    scores[lang] = words.filter(w => set.has(w)).length
  }
  return scores
}

/** The language with the most stopword hits, when it is clearly ahead; else null. */
export function detectLanguage(text: string): string | null {
  const entries = Object.entries(stopwordScores(text)).sort((a, b) => b[1] - a[1])
  const [best, second] = entries
  if (!best || best[1] < 3) return null
  if (second && best[1] < second[1] * 1.5) return null
  return best[0]
}

function prose(text: string): string {
  // Tables, headings, quotes and list bullets say little about the language.
  return stripPlaceholders(text).split('\n').filter(l => !/^\s*[|#>-]/.test(l)).join('\n')
}

function checkLanguage(input: ValidationInput, out: ValidationProblem[]): void {
  const target = languageCode(input.targetLanguage)
  if (input.mode !== 'translate' || !target) return
  const source = detectLanguage(prose(input.source))
  if (!source || source === target) return
  const paragraphs = prose(input.output).split(/\n\s*\n/)
  let untranslated = 0
  for (const p of paragraphs) {
    if ((p.match(WORD_RE) ?? []).length < 8) continue
    const scores = stopwordScores(p)
    if ((scores[source] ?? 0) > (scores[target] ?? 0)) untranslated++
  }
  if (untranslated > 0) out.push(problem('untranslated', `${untranslated} paragraph(s) of your answer are still in the source language. Translate every paragraph into ${input.targetLanguage}.`))
}

// ── terminology ─────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Character ranges of the sentences of `text` that contain a glossary source term. */
function glossarySentenceRanges(text: string, glossary: readonly GlossaryEntry[]): Array<[number, number]> {
  const terms = glossary.map(g => g.source.trim()).filter(t => t.length > 0)
  if (terms.length === 0) return []
  // eslint-disable-next-line security/detect-non-literal-regexp -- glossary terms, escaped literally
  const termRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRegExp).join('|')})`, 'iu')
  return sentenceRanges(text).filter(([s, e]) => termRe.test(text.slice(s, e)))
}

/** Sentences as [start, end): they end after . ! ? followed by whitespace, or at a line break. */
function sentenceRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const endsSentence = c === '\n' || ((c === '.' || c === '!' || c === '?') && /\s/.test(text[i + 1] ?? ' '))
    if (endsSentence) {
      if (i + 1 > start) out.push([start, i + 1])
      start = i + 1
    }
  }
  if (start < text.length) out.push([start, text.length])
  return out
}

/** Characters removed from or inserted into `source` at positions `inAllowed` rejects. */
function changedCharsOutside(source: string, output: string, inAllowed: (pos: number) => boolean): number {
  let pos = 0
  let changed = 0
  for (const part of diffWordsWithSpace(source, output)) {
    if (part.added) {
      if (!inAllowed(pos)) changed += part.value.length
      continue
    }
    if (part.removed) {
      for (let i = 0; i < part.value.length; i++) if (!inAllowed(pos + i)) changed++
    }
    pos += part.value.length
  }
  return changed
}

function checkTerminology(input: ValidationInput, out: ValidationProblem[]): void {
  if (input.mode !== 'terminology' || !input.glossary || input.glossary.length === 0) return
  const allowed = glossarySentenceRanges(input.source, input.glossary)
  const inAllowed = (pos: number): boolean => allowed.some(([s, e]) => pos >= s && pos <= e)
  const changedOutside = changedCharsOutside(input.source, input.output, inAllowed)
  const base = Math.max(1, stripPlaceholders(input.source).length)
  if (changedOutside / base > TERMINOLOGY_SPREAD_MAX) {
    out.push(problem('terminology_spread', 'Your answer changes text outside the sentences that contain a glossary term. Change only those sentences.'))
  }
}

// ── em-dash auto-fix ────────────────────────────────────────────────────

export interface DashFix {
  /** The answer with the worker's em-dashes replaced. */
  output: string
  /** How many em-dash runs were replaced (0: unchanged). */
  fixed: number
}

/** Output offsets of the parts `diffWordsWithSpace` marks as added (what the worker wrote, not what it kept). */
function addedOffsets(source: string, output: string): (offset: number) => boolean {
  const ranges: Array<[number, number]> = []
  let at = 0
  for (const part of diffWordsWithSpace(source, output)) {
    if (part.removed) continue
    if (part.added) ranges.push([at, at + part.value.length])
    at += part.value.length
  }
  return offset => ranges.some(([a, b]) => offset >= a && offset < b)
}

/**
 * Replace the em-dashes a worker wrote, before validation, with the same
 * filter as the editor tools (`dashFilter.ts`), so a dash never costs a
 * retry. Rewrites and translations are entirely the worker's text;
 * terminology keeps the dashes the unit already had (only added parts
 * are filtered); comment findings filter issue and suggestion but never
 * the quote (it must match the unit); scan items are terms from the
 * document and stay as they are.
 */
export function fixWorkerDashes(mode: JobMode, source: string, output: string): DashFix {
  if (!output.includes(EM_DASH) || mode === 'scan') return { output, fixed: 0 }
  if (mode === 'comment') {
    const arr = parseJsonArray(output)
    if (arr === null) return { output, fixed: 0 }
    let fixed = 0
    const field = (v: unknown): unknown => {
      if (typeof v !== 'string') return v
      const r = filterEmDashes(v)
      fixed += r.replaced
      return r.text
    }
    const next = arr.map(f => (isRecord(f) ? { ...f, issue: field(f.issue), ...(f.suggestion === undefined ? {} : { suggestion: field(f.suggestion) }) } : f))
    return fixed === 0 ? { output, fixed: 0 } : { output: JSON.stringify(next), fixed }
  }
  const r = filterEmDashes(output, mode === 'terminology' ? { allow: addedOffsets(source, output) } : {})
  return { output: r.text, fixed: r.replaced }
}

// ── JSON modes ──────────────────────────────────────────────────────────

function parseArrayText(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Parse a JSON array answer, tolerating a ```json fence around it (an
 * opening fence alone when the answer was cut off). `salvage` keeps the
 * complete items of an array that ran out of tokens: everything up to the
 * last closing brace of an item.
 */
function parseJsonArray(output: string, salvage = false): unknown[] | null {
  const lines = output.trim().split('\n')
  const opens = lines.length >= 2 && (lines[0] ?? '').startsWith('```')
  const closes = opens && (lines.at(-1) ?? '').trim() === '```'
  const body = opens ? lines.slice(1) : lines
  const text = (closes ? body.slice(0, -1) : body).join('\n').trim()
  const whole = !opens || closes ? parseArrayText(text) : null
  if (whole || !salvage || !text.startsWith('[')) return whole
  const lastItemEnd = text.lastIndexOf('}')
  return lastItemEnd === -1 ? null : parseArrayText(`${text.slice(0, lastItemEnd + 1)}]`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Comment-mode findings of a valid answer (call after `validateWorkerOutput` passed). */
export function parseCommentFindings(output: string): CommentFinding[] {
  const arr = parseJsonArray(output) ?? []
  return arr.filter(isRecord).map(f => ({
    quote: String(f.quote ?? ''),
    issue: String(f.issue ?? ''),
    ...(typeof f.suggestion === 'string' && f.suggestion.trim() ? { suggestion: f.suggestion } : {}),
    severity: f.severity === 'high' || f.severity === 'medium' ? f.severity : 'low'
  }))
}

/** Scan-mode items of a valid answer. */
export function parseScanItems(output: string): ScanItem[] {
  const arr = parseJsonArray(output, true) ?? []
  return arr.filter(isRecord).map(i => ({
    text: String(i.text ?? ''),
    ...(typeof i.example === 'string' && i.example.trim() ? { example: i.example } : {})
  }))
}

function checkComments(input: ValidationInput, out: ValidationProblem[]): void {
  const arr = parseJsonArray(input.output)
  if (arr === null) {
    out.push(problem('invalid_json', 'Your answer is not a JSON array. Return only the JSON array of findings.'))
    return
  }
  if (arr.length > MAX_FINDINGS) out.push(problem('invalid_finding', `Return at most ${MAX_FINDINGS} findings, the most valuable ones.`))
  arr.forEach((f, i) => {
    const ok = isRecord(f)
      && typeof f.quote === 'string' && f.quote.trim() !== ''
      && typeof f.issue === 'string' && f.issue.trim() !== ''
      && (f.suggestion === undefined || typeof f.suggestion === 'string')
      && (f.severity === 'low' || f.severity === 'medium' || f.severity === 'high')
    if (!ok) {
      out.push(problem('invalid_finding', `Finding ${i + 1} does not match {"quote", "issue", "suggestion"?, "severity": "low"|"medium"|"high"}.`))
      return
    }
    if (!input.source.includes(f.quote as string)) out.push(problem('quote_not_found', `The quote of finding ${i + 1} is not an exact substring of the unit. Copy the quote character by character.`))
  })
  const text = arr.filter(isRecord).map(f => `${String(f.issue ?? '')} ${String(f.suggestion ?? '')}`).join('\n')
  checkNewContent({ ...input, output: text }, out)
  if (text.includes(EM_DASH)) out.push(problem('em_dash', 'Your findings contain the em-dash character (U+2014). Use a comma, colon or parentheses instead.'))
}

function checkScan(input: ValidationInput, out: ValidationProblem[]): void {
  // A list cut off by the token limit keeps its complete items: a scan
  // is an inventory, a shorter one is still useful.
  const arr = parseJsonArray(input.output, true)
  if (arr === null) {
    out.push(problem('invalid_json', 'Your answer is not a JSON array. Return only the JSON array of items.'))
    return
  }
  if (arr.length > MAX_SCAN_ITEMS) out.push(problem('invalid_finding', `Return at most ${MAX_SCAN_ITEMS} items.`))
  if (arr.some(i => !isRecord(i) || typeof i.text !== 'string' || i.text.trim() === '' || (i.example !== undefined && typeof i.example !== 'string'))) {
    out.push(problem('invalid_finding', 'Every item must be {"text": string, "example"?: string}.'))
  }
}

/** Check one worker answer. `ok` is true exactly when there are no problems. */
export function validateWorkerOutput(input: ValidationInput): ValidationResult {
  const problems: ValidationProblem[] = []
  if (input.output.trim() === '') {
    problems.push(problem('empty', 'Your answer is empty.'))
    return { ok: false, problems }
  }
  if (input.mode === 'comment') {
    checkComments(input, problems)
  } else if (input.mode === 'scan') {
    checkScan(input, problems)
  } else {
    checkForm(input, problems)
    checkPlaceholders(input, problems)
    checkNewContent(input, problems)
    checkStructure(input, problems)
    checkLength(input, problems)
    checkLanguage(input, problems)
    checkTerminology(input, problems)
  }
  return { ok: problems.length === 0, problems }
}

/** The problem sentences, as retry feedback for the worker. */
export function retryFeedback(result: ValidationResult): string[] {
  return result.problems.map(p => p.message)
}
