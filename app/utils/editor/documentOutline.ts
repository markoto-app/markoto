import type { Token } from 'markdown-it'

// The document outline of the editor's left panel: the headings of the
// Markdown source as a nested tree. The headings come from the same
// markdown-it pipeline the preview renders with (`parseMarkdownTokens`), so
// a heading inside a code fence, a comment or a math block is no heading
// here either, and each entry carries the very anchor id the preview gives
// it (markdown-it-anchor or an explicit `{#id}`), which the preview scrolls
// to. Pure functions; the panel debounces and runs them.

export interface OutlineHeading {
  /** The heading's anchor id in the preview. */
  id: string
  /** 1 to 6. */
  level: number
  /** The heading's visible text (inline Markdown reduced to text). */
  text: string
  /** 0-based line of the heading in the source. */
  line: number
}

export interface OutlineNode {
  heading: OutlineHeading
  /** Position of the heading in the flat list. */
  index: number
  children: OutlineNode[]
}

/** The token fields the outline reads (markdown-it's `Token`). */
type OutlineToken = Pick<Token, 'type' | 'tag' | 'map' | 'content'> & {
  attrGet: (name: string) => string | number | null
  children: OutlineToken[] | null
}

/** The longest frontmatter block looked for, in lines. */
const FRONTMATTER_MAX_LINES = 400
const YAML_KEY_RE = /^[\w-]+[ \t]*:/

/**
 * `source` with a leading YAML frontmatter block (`---` … `---` or `...`
 * with at least one `key:` line) replaced by as many empty lines, so the
 * line numbers stay those of the source. The preview renders such a block
 * as a rule and a heading; it is metadata, not part of the outline.
 */
export function maskFrontmatter(source: string): string {
  if (!source.startsWith('---')) return source
  const lines = source.split('\n')
  if (lines[0]?.trimEnd() !== '---') return source
  const last = Math.min(lines.length, FRONTMATTER_MAX_LINES)
  for (let i = 1; i < last; i++) {
    const line = (lines[i] ?? '').trimEnd()
    if (line !== '---' && line !== '...') continue
    if (!lines.slice(1, i).some(l => YAML_KEY_RE.test(l))) return source
    return '\n'.repeat(i + 1) + lines.slice(i + 1).join('\n')
  }
  return source
}

/** The visible text of a heading's inline token. */
function inlineText(inline: OutlineToken | undefined): string {
  if (!inline) return ''
  let out = ''
  for (const child of inline.children ?? []) {
    if (child.type === 'softbreak' || child.type === 'hardbreak') out += ' '
    else if (child.type === 'text' || child.type === 'code_inline' || child.type === 'emoji' || child.type === 'math_inline') out += child.content
  }
  const text = out.replaceAll(/\s+/g, ' ').trim()
  return text || inline.content.trim()
}

/** Every heading of a markdown-it token stream, in document order. Headings without text are left out. */
export function headingsFromTokens(tokens: readonly OutlineToken[]): OutlineHeading[] {
  const out: OutlineHeading[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token?.type !== 'heading_open' || !token.map) continue
    const level = Number(token.tag.slice(1))
    const text = inlineText(tokens[i + 1])
    if (!text || !(level >= 1 && level <= 6)) continue
    const id = token.attrGet('id')
    out.push({ id: id === null ? '' : String(id), level, text, line: token.map[0] })
  }
  return out
}

/**
 * The headings as a tree: each heading under the nearest heading before it
 * with a lower level. A skipped level (an h3 right after an h1) nests one
 * step, under the h1.
 */
export function buildOutlineTree(headings: readonly OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  headings.forEach((heading, index) => {
    const node: OutlineNode = { heading, index, children: [] }
    while (stack.length > 0 && (stack.at(-1)?.heading.level ?? 0) >= heading.level) stack.pop()
    const parent = stack.at(-1)
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
  })
  return roots
}

/** Index of the section `line` (0-based) is in: the last heading at or above it, or -1 before the first. */
export function activeHeadingIndex(headings: readonly OutlineHeading[], line: number): number {
  let lo = 0
  let hi = headings.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((headings[mid]?.line ?? Infinity) <= line) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}
