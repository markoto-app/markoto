import { CODE_MASK_CLASSES, URL_MASK_CLASSES, overlappingRange, type MaskClass, type MaskRange } from './markdownMask'
import type { DocumentStructure } from './parse'

// Text search over a document for search_document (and the replace step that
// builds on it): plain or regular-expression queries, applied line by line,
// with matches inside excluded Markdown classes (code, math, URLs) skipped
// and counted. Regular expressions come from the model, so they are checked
// before they run: bounded length, no backreferences, no repeated group that
// itself repeats or alternates (the shapes that backtrack exponentially),
// bounded input per exec and a time budget for the whole search.

const MAX_PATTERN_LENGTH = 200
/** Longest stretch of one line a single regex exec sees; longer lines are searched in overlapping windows. */
const MAX_EXEC_CHARS = 10_000
const WINDOW_OVERLAP = 1_000
/** Time a whole search may take. */
const SEARCH_TIME_BUDGET_MS = 2_000
/** Matches collected at most (the count says "at least" beyond it). */
export const MAX_COLLECTED_MATCHES = 10_000
const CLOCK_CHECK_EVERY_LINES = 64

/** Letters, digits and underscore in the scripts markoto documents use (no `u` flag needed). */
const WORD_CHAR = String.raw`[0-9A-Za-z_ªµºÀ-ÖØ-öø-˿Ͱ-ϿЀ-ԯ]`

export interface SearchQuery {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Skip matches in fenced and inline code, math, HTML comments and front matter. */
  excludeCode?: boolean
  /** Skip matches in link and image targets, autolinks, bare URLs, reference definitions and attribute blocks. */
  excludeUrls?: boolean
}

export interface SearchMatch {
  /** Character offsets in the document. */
  start: number
  end: number
  /** 1-based line. */
  line: number
  /** The matched text. */
  text: string
  /** Capture groups (undefined groups as ''). */
  groups: string[]
}

export interface SearchOutcome {
  matches: SearchMatch[]
  /** Whether more than MAX_COLLECTED_MATCHES matched. */
  truncated: boolean
  /** Matches not counted, by the class they fell into. */
  skipped: Partial<Record<MaskClass, number>>
}

export interface SearchRunOptions {
  /** Lines to search (1-based, inclusive); the whole document by default. */
  startLine?: number
  endLine?: number
  timeBudgetMs?: number
  /** Clock in milliseconds (tests pass a fake one). */
  now?: () => number
}

const QUANTIFIER_AFTER_RE = /^(?:[*+]|\{\d{0,9},\d{0,9}\})/
const UNBOUNDED_BRACE_RE = /^\{\d{0,9},\d{0,9}\}/

interface Frame { quantified: boolean, alternation: boolean }

const NESTED_REPEAT = 'a repeated group contains another repetition, like (a+)+, which can take exponential time; repeat only once, e.g. (a+) or a+'
const REPEATED_ALTERNATION = 'a repeated group with alternatives, like (a|ab)*, can take exponential time; search for the alternatives without repeating the group, or use a character class like [ab]+'
const BACKREFERENCE = 'backreferences (\\1, \\k<name>) are not supported; match the text without them'

/** Index of the `]` that closes the character class opened at `open` (a `]` right after `[` or `[^` is literal). */
function classEnd(pattern: string, open: number): number {
  let j = open + 1
  if (pattern[j] === '^') j++
  if (pattern[j] === ']') j++
  while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1
  return j
}

/** A group closes at `i`: check it, fold it into its parent. Returns a problem or null. */
function closeGroup(pattern: string, i: number, stack: Frame[]): string | null {
  const frame = stack.pop()
  const parent = stack.at(-1)
  if (!frame || !parent) return null
  const repeated = QUANTIFIER_AFTER_RE.test(pattern.slice(i + 1))
  if (repeated && frame.quantified) return NESTED_REPEAT
  if (repeated && frame.alternation) return REPEATED_ALTERNATION
  parent.quantified = parent.quantified || frame.quantified || repeated
  return null
}

/** Whether the character at `i` repeats without bound (`*`, `+`, `{n,}`, `{n,m}`). */
function isRepeat(pattern: string, i: number): boolean {
  const c = pattern[i]
  return c === '*' || c === '+' || (c === '{' && UNBOUNDED_BRACE_RE.test(pattern.slice(i)))
}

/** Look at the token at `i`: how far to step, and a problem if the pattern must not run. */
function scanToken(pattern: string, i: number, stack: Frame[]): { step: number, problem: string | null } {
  const c = pattern[i]
  const top = stack.at(-1)
  if (c === '\\') return { step: 2, problem: /[1-9k]/.test(pattern[i + 1] ?? '') ? BACKREFERENCE : null }
  if (c === '[') return { step: classEnd(pattern, i) - i + 1, problem: null }
  if (c === '(') stack.push({ quantified: false, alternation: false })
  // An unbalanced `)` is left to RegExp, which reports it.
  else if (c === ')' && stack.length > 1) return { step: 1, problem: closeGroup(pattern, i, stack) }
  else if (top && c === '|') top.alternation = true
  else if (top && isRepeat(pattern, i)) top.quantified = true
  return { step: 1, problem: null }
}

/**
 * Why a model-written pattern must not run, or null when it may. A
 * conservative static check: some harmless patterns are refused too, with
 * a message that says how to write them instead.
 */
export function regexSafetyProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return `the pattern is ${pattern.length} characters long; at most ${MAX_PATTERN_LENGTH} are allowed`
  const stack: Frame[] = [{ quantified: false, alternation: false }]
  let i = 0
  while (i < pattern.length) {
    const { step, problem } = scanToken(pattern, i, stack)
    if (problem) return problem
    i += step
  }
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The RegExp a query runs as (global), or the error to show the model. */
export function buildSearchRegExp(q: SearchQuery): { ok: true, re: RegExp } | { ok: false, error: string } {
  if (q.query.length === 0) return { ok: false, error: 'Error: query is empty.' }
  let source: string
  if (q.regex) {
    const problem = regexSafetyProblem(q.query)
    if (problem) return { ok: false, error: `Error: this regular expression is not allowed: ${problem}.` }
    source = q.query
  } else {
    if (q.query.length > MAX_PATTERN_LENGTH * 2) return { ok: false, error: `Error: query is longer than ${MAX_PATTERN_LENGTH * 2} characters.` }
    source = escapeRegExp(q.query)
  }
  if (q.wholeWord) source = `(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})`
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- model input, passed through regexSafetyProblem (length, no backreferences, no nested or alternating repetition) or escaped; every exec sees at most one bounded window of a line, and searchLines enforces a time budget
    const re = new RegExp(source, q.caseSensitive ? 'g' : 'gi')
    if (re.test('')) return { ok: false, error: 'Error: the pattern matches empty text; make it match at least one character.' }
    re.lastIndex = 0
    return { ok: true, re }
  } catch (e) {
    return { ok: false, error: `Error: invalid regular expression: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function excludedClasses(q: SearchQuery): Set<MaskClass> {
  const out = new Set<MaskClass>()
  if (q.excludeCode ?? true) for (const c of CODE_MASK_CLASSES) out.add(c)
  if (q.excludeUrls ?? true) for (const c of URL_MASK_CLASSES) out.add(c)
  return out
}

/** Collects matches and skipped counts for one search. */
class MatchCollector {
  readonly matches: SearchMatch[] = []
  readonly skipped: Partial<Record<MaskClass, number>> = {}
  truncated = false

  constructor(private readonly masks: readonly MaskRange[], private readonly excluded: ReadonlySet<MaskClass>) {}

  take(lineNo: number, start: number, m: RegExpExecArray): void {
    const end = start + m[0].length
    const hit = overlappingRange(this.masks, start, end)
    if (hit && this.excluded.has(hit.cls)) {
      this.skipped[hit.cls] = (this.skipped[hit.cls] ?? 0) + 1
      return
    }
    if (this.matches.length >= MAX_COLLECTED_MATCHES) {
      this.truncated = true
      return
    }
    this.matches.push({ start, end, line: lineNo, text: m[0], groups: m.slice(1).map(g => g ?? '') })
  }
}

/**
 * Run `re` over one line. Long lines are searched in overlapping windows of
 * MAX_EXEC_CHARS; a match belongs to the window it starts in.
 */
function searchLine(re: RegExp, line: string, lineNo: number, lineStart: number, out: MatchCollector): void {
  for (let w = 0; w === 0 || w < line.length; w += MAX_EXEC_CHARS) {
    const chunk = line.slice(w, w + MAX_EXEC_CHARS + WINDOW_OVERLAP)
    const lastWindow = w + MAX_EXEC_CHARS >= line.length
    re.lastIndex = 0
    let m = re.exec(chunk)
    while (m !== null && (lastWindow || m.index < MAX_EXEC_CHARS)) {
      if (m[0].length === 0) re.lastIndex += 1
      else out.take(lineNo, lineStart + w + m.index, m)
      m = re.exec(chunk)
    }
  }
}

/**
 * Every match of `q` in the given lines, in document order. Matches never
 * span lines. Fails with a message when the pattern is refused or the
 * search runs out of time.
 */
export function searchLines(
  structure: DocumentStructure,
  masks: readonly MaskRange[],
  q: SearchQuery,
  opts: SearchRunOptions = {}
): { ok: true, outcome: SearchOutcome } | { ok: false, error: string } {
  const built = buildSearchRegExp(q)
  if (!built.ok) return built
  const now = opts.now ?? (() => performance.now())
  const budget = opts.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS
  const started = now()
  const first = Math.max(1, opts.startLine ?? 1)
  const last = Math.min(structure.lines.length, opts.endLine ?? structure.lines.length)
  const out = new MatchCollector(masks, excludedClasses(q))
  for (let lineNo = first; lineNo <= last; lineNo++) {
    if ((lineNo - first) % CLOCK_CHECK_EVERY_LINES === 0 && now() - started > budget) {
      return { ok: false, error: `Error: the search took longer than ${budget / 1000} seconds and was stopped at line ${lineNo}. Use a simpler pattern (plain text, or fewer wildcards) or a narrower scope.` }
    }
    searchLine(built.re, structure.lines[lineNo - 1] ?? '', lineNo, structure.lineOffsets[lineNo - 1] ?? 0, out)
  }
  return { ok: true, outcome: { matches: out.matches, truncated: out.truncated, skipped: out.skipped } }
}

const CLASS_LABELS: Record<MaskClass, string> = {
  code_block: 'code blocks',
  inline_code: 'inline code',
  math: 'math',
  html_comment: 'HTML comments',
  frontmatter: 'front matter',
  link_target: 'link targets',
  url: 'URLs',
  attribute: 'attribute blocks ({#id})'
}

/** "3 in code blocks, 1 in link targets", or '' when nothing was skipped. */
export function describeSkipped(skipped: Partial<Record<MaskClass, number>>): string {
  return Object.entries(skipped)
    .flatMap(([cls, n]) => (n && n > 0 ? [`${n} in ${CLASS_LABELS[cls as MaskClass]}`] : []))
    .join(', ')
}
