import { parseSections } from '../tools/sections/parse'
import { headingSlugBase } from '../../../../shared/utils/markdown/headingSlug'

// Stable anchors for translated headings. The preview gives a heading
// without an explicit id the slug of its text (markdown-it-anchor with
// `headingSlugBase`, duplicates numbered -1, -2, ...). Translating the
// heading would change that slug and break `[see](#methoden)` links and
// TOC targets, so the job adds the OLD slug as an explicit id
// (`## Methods {#methoden}`) unless the heading already has one.
// Pure (explicit imports only).
//
// Caveat: in the browser a slug that names a DOM property (`method`,
// `title`) gets a `-section` suffix (`clobberSafeId`, needs a DOM). Pass a
// `slugify` that mirrors it when that matters; the default does not.

export type Slugify = (text: string) => string

/**
 * The text markdown-it-anchor slugs: the heading's inline text without
 * Markdown syntax (link and emphasis markers removed, images dropped,
 * inline code kept).
 */
export function headingInlineText(title: string): string {
  return stripLinks(title)
    .replace(/<[^<>]*>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~|==|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .trim()
}

/** End of the target after a link text closing at `close` (`(url)` or `[ref]`), or -1. */
function linkEnd(text: string, close: number): number {
  const kind = text[close + 1]
  if (kind === '(') return text.indexOf(')', close + 2)
  if (kind === '[') return text.indexOf(']', close + 2)
  return -1
}

/** Links become their text (`[t](u)`, `[t][ref]`), images disappear (`![a](u)`). */
function stripLinks(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('[', i)
    const close = open === -1 ? -1 : text.indexOf(']', open + 1)
    const end = close === -1 ? -1 : linkEnd(text, close)
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

export interface HeadingSlug {
  /** Offset of the heading line in the text. */
  startOffset: number
  title: string
  /** The id the preview gives the heading. */
  slug: string
  /** The heading carries an explicit `{#id}`. */
  explicit: boolean
}

/** The anchor of every heading of a document, in order, with markdown-it-anchor's duplicate numbering. */
export function documentHeadingSlugs(text: string, slugify: Slugify = headingSlugBase): HeadingSlug[] {
  const used = new Set<string>()
  const out: HeadingSlug[] = []
  for (const s of parseSections(text).sections) {
    if (s.level === 0) continue
    if (s.explicitId) {
      used.add(s.explicitId)
      out.push({ startOffset: s.startOffset, title: s.title, slug: s.explicitId, explicit: true })
      continue
    }
    const base = slugify(headingInlineText(s.title))
    let slug = base
    let n = 1
    while (used.has(slug)) slug = `${base}-${n++}`
    used.add(slug)
    out.push({ startOffset: s.startOffset, title: s.title, slug, explicit: false })
  }
  return out
}

/** An ATX heading line without its closing `#` sequence (only when a space precedes it). */
function withoutClosingHashes(line: string): string {
  const trimmed = line.trimEnd()
  let i = trimmed.length
  while (i > 0 && trimmed[i - 1] === '#') i--
  return i < trimmed.length && i > 0 && /[ \t]/.test(trimmed[i - 1] ?? '') ? trimmed.slice(0, i).trimEnd() : trimmed
}

/** Append ` {#id}` to the heading that starts at `lineIndex` (ATX: drop a closing `#` sequence first; setext: the text line). */
function withExplicitId(line: string, id: string): string {
  const atx = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)
  const body = atx ? withoutClosingHashes(line) : line.trimEnd()
  return `${body} {#${id}}`
}

/**
 * Give every renamed heading of `newText` the anchor its counterpart in
 * `oldText` had. `oldSlugs` are the slugs of `oldText`'s headings in order
 * (from `documentHeadingSlugs` of the whole document, so duplicate
 * numbering is right). Headings are paired by position (the validators
 * keep the heading count). Headings that keep their text or already carry
 * an id are left alone.
 */
export function addStableAnchors(oldText: string, newText: string, oldSlugs: readonly string[]): { text: string, added: number } {
  const oldHeadings = parseSections(oldText).sections.filter(s => s.level > 0)
  const parsed = parseSections(newText)
  const newHeadings = parsed.sections.filter(s => s.level > 0)
  const lines = [...parsed.lines]
  let added = 0
  newHeadings.forEach((h, k) => {
    const before = oldHeadings[k]
    const slug = oldSlugs[k]
    if (!before || !slug || h.explicitId || before.title.trim() === h.title.trim()) return
    const idx = h.startLine - 1
    lines[idx] = withExplicitId(lines[idx] ?? '', slug)
    added++
  })
  return { text: added > 0 ? lines.join('\n') : newText, added }
}
