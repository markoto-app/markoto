/**
 * Accessibility checks on the Markdown source, shown in the editor's status
 * bar. They cover what the tagged PDF can't fix on its own: an image needs
 * alternative text, headings must not skip a level (a screen reader's
 * outline and the PDF bookmarks follow them), and a link needs text to be
 * announced. A line scanner, not a full parse: fenced code, inline code
 * and comments are skipped; setext headings and reference-style links are
 * not checked.
 */

export type AccessibilityIssue
  = | { kind: 'image-alt', line: number, from: number, to: number }
    | { kind: 'empty-link', line: number, from: number, to: number }
    | { kind: 'heading-skip', line: number, from: number, to: number, level: number, previousLevel: number }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/
// `![alt](` and `[text](` openers; the link opener must not follow a `!`.
// Text between the brackets has no brackets (no nesting), bounded length.
const IMAGE_RE = /!\[([^\]\n]{0,500})\]\(/g
const LINK_RE = /(^|[^!\\\]])\[([^\]\n]{0,500})\]\(/g

/** A source line with code and comments blanked out (offsets unchanged). */
interface ProseLine {
  text: string
  /** 1-based line number. */
  line: number
  /** Offset of the line's first character in the document. */
  start: number
  /** Length of the original line. */
  length: number
}

/** Replace a range with spaces so offsets stay the same. */
function blank(text: string, from: number, to: number): string {
  return text.slice(0, from) + ' '.repeat(to - from) + text.slice(to)
}

/** Inline code spans and single-line comments blanked out. */
function maskInline(line: string): string {
  let out = line
  for (const m of line.matchAll(/(`+)[^`]*?\1/g)) out = blank(out, m.index, m.index + m[0].length)
  for (const m of out.matchAll(/<!--.*?-->/g)) out = blank(out, m.index, m.index + m[0].length)
  return out
}

/** The lines outside fenced code and comments, prose only. */
function proseLines(markdown: string): ProseLine[] {
  const out: ProseLine[] = []
  let offset = 0
  let fence: string | null = null
  let inComment = false
  markdown.split('\n').forEach((raw, i) => {
    const start = offset
    offset += raw.length + 1
    if (fence) {
      const close = FENCE_RE.exec(raw)?.[1]
      if (close?.startsWith(fence[0] ?? '') && close.length >= fence.length) fence = null
      return
    }
    let text = raw
    if (inComment) {
      const end = text.indexOf('-->')
      if (end < 0) return
      inComment = false
      text = blank(text, 0, end + 3)
    }
    const open = FENCE_RE.exec(text)?.[1]
    if (open) {
      fence = open
      return
    }
    text = maskInline(text)
    const commentStart = text.indexOf('<!--')
    if (commentStart >= 0) {
      inComment = true
      text = text.slice(0, commentStart)
    }
    out.push({ text, line: i + 1, start, length: raw.length })
  })
  return out
}

function emptyImageAlts(p: ProseLine): AccessibilityIssue[] {
  return [...p.text.matchAll(IMAGE_RE)]
    .filter(m => (m[1] ?? '').trim() === '')
    .map(m => ({ kind: 'image-alt', line: p.line, from: p.start + m.index, to: p.start + m.index + m[0].length }))
}

function emptyLinks(p: ProseLine): AccessibilityIssue[] {
  return [...p.text.matchAll(LINK_RE)]
    .filter(m => (m[2] ?? '').trim() === '')
    .map(m => ({
      kind: 'empty-link',
      line: p.line,
      from: p.start + m.index + (m[1] ?? '').length,
      to: p.start + m.index + m[0].length
    }))
}

export function checkAccessibility(markdown: string): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = []
  let previousLevel = 0
  for (const p of proseLines(markdown)) {
    const level = HEADING_RE.exec(p.text)?.[1]?.length
    if (level) {
      if (previousLevel > 0 && level > previousLevel + 1) {
        issues.push({ kind: 'heading-skip', line: p.line, from: p.start, to: p.start + p.length, level, previousLevel })
      }
      previousLevel = level
    }
    issues.push(...emptyImageAlts(p), ...emptyLinks(p))
  }
  return issues
}
