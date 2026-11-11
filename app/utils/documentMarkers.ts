import { SECTION_HEADING_CLASS } from './headingStructure'
import { capParagraph } from './dropcapWrap'

/**
 * Marker classes on the composed body for template CSS (`composeFinalHtml`,
 * after `markHeadingStructure`; parsed DOM of sanitised markup, sanitised
 * again afterwards; browser-only):
 *
 * - `markoto-lead` on the body's opening paragraph — the first top-level
 *   block, past a contents list, page break or rule — i.e. the paragraph
 *   right after the cover / title block (a one-pager's pitch, a report's
 *   standfirst). A body that opens with a heading has no lead.
 * - `markoto-opening` around the first words of the first paragraph after
 *   every top-level section heading (and of the lead), the way
 *   `dropcapWrap.ts` wraps the first letter — so a book template can set
 *   the opening words in small capitals. Up to four words, ending early
 *   after clause punctuation; after a drop cap it continues the word.
 * - `body.dropCap: 'every-chapter'`: the drop cap on each of those
 *   chapter-opening paragraphs (same rules as the single drop cap).
 */
const LEAD_CLASS = 'markoto-lead'
const OPENING_CLASS = 'markoto-opening'

/** Top-level blocks skipped when looking for the lead. */
const BEFORE_LEAD = new Set(['NAV', 'HR'])

const MAX_OPENING_WORDS = 4
const CLAUSE_END = /[,;:.!?…—–]["'”’»)]*$/

const TEXT_NODE = 3
const ELEMENT_NODE = 1
// No `span`: KaTeX and footnotes are spans, and their text must stay whole.
const DESCEND_INTO = new Set(['a', 'abbr', 'b', 'del', 'em', 'i', 'ins', 'mark', 's', 'strong', 'u'])

export interface DocumentMarkerOptions {
  /** `body.dropCap === 'every-chapter'`. */
  capChapters: boolean
}

export function markDocumentStructure(bodyHtml: string, opts: DocumentMarkerOptions): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = bodyHtml
  const root = tpl.content
  const lead = findLead(root)
  if (lead) lead.classList.add(LEAD_CLASS)
  const openings = Array.from(root.children)
    .filter(el => el.classList.contains(SECTION_HEADING_CLASS))
    .map(firstParagraphAfter)
    .filter((p): p is Element => p !== null)
  if (opts.capChapters) for (const p of openings) capParagraph(p)
  for (const p of new Set([...(lead ? [lead] : []), ...openings])) wrapOpening(p)
  const wrap = document.createElement('div')
  wrap.append(root)
  return wrap.innerHTML
}

function findLead(root: DocumentFragment): Element | null {
  for (const el of Array.from(root.children)) {
    if (BEFORE_LEAD.has(el.tagName) || el.classList.contains('page-break')) continue
    return el.tagName === 'P' ? el : null
  }
  return null
}

/** The first top-level `<p>` after `heading`, before the next top-level section heading. */
function firstParagraphAfter(heading: Element): Element | null {
  for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.classList.contains(SECTION_HEADING_CLASS)) return null
    if (el.tagName === 'P') return el
  }
  return null
}

/** First text node with words in `parent`, past a drop cap, descending into inline formatting. */
function openingTextNode(parent: Node): Text | null {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      if (child instanceof Text && child.data.trim() !== '') return child
      continue
    }
    if (child.nodeType !== ELEMENT_NODE || !(child instanceof Element)) continue
    if (child.classList.contains('markoto-dropcap')) continue
    if (child.classList.contains(OPENING_CLASS)) return null
    return DESCEND_INTO.has(child.tagName.toLowerCase()) ? openingTextNode(child) : null
  }
  return null
}

function wrapOpening(p: Element): void {
  const text = openingTextNode(p)
  if (!text) return
  const m = /^(\s*)(\S[\s\S]*)$/.exec(text.data)
  if (!m) return
  const [, leading = '', body = ''] = m
  // Words up to MAX_OPENING_WORDS, ending early after clause punctuation.
  const words = body.split(/(\s+)/)
  let end = 0
  let count = 0
  for (let i = 0; i < words.length; i += 2) {
    const word = words[i] ?? ''
    if (!word) break
    end = words.slice(0, i + 1).join('').length
    count++
    if (count >= MAX_OPENING_WORDS || CLAUSE_END.test(word)) break
  }
  if (end === 0) return
  const doc = text.ownerDocument
  const span = doc.createElement('span')
  span.className = OPENING_CLASS
  span.textContent = body.slice(0, end)
  const tail = doc.createTextNode(body.slice(end))
  text.data = leading
  text.after(span, tail)
  if (leading === '') text.remove()
}
