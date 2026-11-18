import { headingSlugBase } from '~~/shared/utils/markdown/headingSlug'
import type { DocumentStructure, Section } from './parse'

// The anchor id each heading renders with today, so the edit tools can
// point links at a renamed heading's new anchor (`anchorLinks.ts`) instead
// of pinning stale explicit ids. Used by set_heading, replace_all and
// renumber_headings. Pure functions over the parsed structure.

/**
 * Slugs the browser renderer suffixes with `-section` (DOMPurify drops ids
 * that name a property of `document` or of a `<form>`, `clobberSafeId` in
 * `app/utils/markdown/renderMarkdown.ts` checks it against a live DOM).
 * The server has no DOM, so this lists the names a heading plausibly
 * slugifies to; a rarer one is pinned without the suffix and the
 * sanitiser then drops that id, as it already does today.
 */
const CLOBBERED_SLUGS: ReadonlySet<string> = new Set([
  'action', 'all', 'anchors', 'attributes', 'body', 'children', 'close', 'contains', 'cookie', 'dir',
  'domain', 'elements', 'embeds', 'encoding', 'enctype', 'forms', 'fonts', 'head', 'hidden', 'id',
  'images', 'implementation', 'lang', 'length', 'links', 'location', 'method', 'name', 'normalize', 'open',
  'plugins', 'referrer', 'reset', 'scripts', 'style', 'submit', 'target', 'title', 'url', 'write'
])

/** Remove `[text](target)` link targets (keeping the text) and `![alt](src)` images. */
function stripLinks(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('[', i)
    const close = open === -1 ? -1 : text.indexOf('](', open)
    const end = close === -1 ? -1 : text.indexOf(')', close + 2)
    if (end === -1) {
      out += text.slice(i)
      break
    }
    const image = open > 0 && text[open - 1] === '!'
    out += text.slice(i, image ? open - 1 : open) + (image ? '' : text.slice(open + 1, close))
    i = end + 1
  }
  return out
}

const WORDISH_RE = /[\p{L}\p{N}]/u

/** Drop emphasis and code marks (`*`, `~`, backticks, `==`, `++`, `_` at word edges) and backslash escapes. */
function stripMarks(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i)
    if (c === '\\' && i + 1 < text.length) {
      out += text.charAt(++i)
      continue
    }
    const pair = text.slice(i, i + 2)
    if (pair === '==' || pair === '++') {
      i++
      continue
    }
    if (c === '*' || c === '~' || c === '`') continue
    if (c === '_' && !(WORDISH_RE.test(text.charAt(i - 1)) && WORDISH_RE.test(text.charAt(i + 1)))) continue
    out += c
  }
  return out
}

/** The heading's text as the renderer sees it for the slug: inline Markdown reduced to its visible text. */
function headingVisibleText(title: string): string {
  return stripMarks(stripLinks(title).replaceAll(/<[^<>]{1,200}>/g, ''))
}

/** Where an ATX closing sequence (`## Title ##`: trailing `#`s after a space) starts in `line`, or -1. */
export function atxClosingStart(line: string): number {
  const trimmed = line.trimEnd()
  let i = trimmed.length
  while (i > 0 && trimmed[i - 1] === '#') i--
  if (i === trimmed.length || i === 0) return -1
  let j = i
  while (j > 0 && (trimmed[j - 1] === ' ' || trimmed[j - 1] === '\t')) j--
  return j < i ? j : -1
}

function slugFor(title: string): string {
  const base = headingSlugBase(headingVisibleText(title))
  return CLOBBERED_SLUGS.has(base) ? `${base}-section` : base
}

/**
 * The id every heading renders with, by section index: its explicit id, or
 * the slug of its text made unique like markdown-it-anchor does (`-1`,
 * `-2`, ... for repeats, in document order).
 */
export function currentHeadingAnchors(structure: DocumentStructure): Map<number, string> {
  const taken = new Set<string>()
  const out = new Map<number, string>()
  for (const s of structure.sections) {
    if (s.level === 0) continue
    const base = s.explicitId ?? slugFor(s.title)
    if (!base) continue
    let id = base
    let n = 1
    while (taken.has(id)) id = `${base}-${n++}`
    taken.add(id)
    out.set(s.index, id)
  }
  return out
}

/** Whether the heading is ATX (`## Title`) rather than setext (underlined). */
export function isAtxHeading(section: Section): boolean {
  return section.headingLines === 1
}
