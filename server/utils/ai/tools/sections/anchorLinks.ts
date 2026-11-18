import { CODE_MASK_CLASSES, classifyMarkdownCached, overlappingRange } from './markdownMask'
import { parseSections, type DocumentStructure } from './parse'
import { currentHeadingAnchors } from './headingAnchors'

// When a heading's text changes, its automatic anchor (the slug of the text)
// changes too, and every in-document link to the old anchor would break.
// Instead of pinning the old slug as an explicit `{#id}` on the heading (which
// freezes stale ids like `h-1211-risiken` into the text), the edit tools
// point those links at the new anchor in the same edit. Optionally, when a
// heading's number changes ("12.3" → "10.3"), the visible number in the link
// text ("[Abschnitt 12.3](#wiederanlauf)") follows. Pure functions.

export interface TextEdit {
  start: number
  end: number
  text: string
}

export interface LinkRetarget {
  edits: TextEdit[]
  /** Link targets pointed at a heading's new anchor. */
  retargeted: number
  /** Link texts whose section number was updated. */
  relabelled: number
}

/** `[text](#id ...)`: the text and the id after `#`. */
const INLINE_LINK_RE = /\[([^\]\n]{0,300})\]\(\s*<?#([^\s)>"']{1,200})/g
/** `[label]: #id` reference definitions and `href="#id"` in inline HTML. */
const OTHER_TARGET_RE = /(?:^ {0,3}\[[^\]\n]{1,200}\]:[ \t]*<?|href=["'])#([^\s)>"']{1,200})/gm

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

/** Offset of `number` as a whole section number inside `text` ("12.3", but not inside "112.3" or "12.31"), or -1. */
function numberTokenAt(text: string, number: string): number {
  let at = text.indexOf(number)
  while (at !== -1) {
    const before = text[at - 1]
    const after = text[at + number.length]
    const continues = isDigit(after) || (after === '.' && isDigit(text[at + number.length + 1]))
    if (!isDigit(before) && before !== '.' && !continues) return at
    at = text.indexOf(number, at + 1)
  }
  return -1
}

interface AnchorMaps {
  /** Old automatic or explicit id → section index. */
  indexOfOldId: Map<string, number>
  /** The heading's new id when it differs from `oldId`, else null. */
  newIdFor: (oldId: string) => string | null
}

function anchorMaps(before: DocumentStructure, afterText: string): AnchorMaps | null {
  const after = parseSections(afterText)
  const headingsBefore = before.sections.filter(s => s.level > 0)
  const headingsAfter = after.sections.filter(s => s.level > 0)
  if (headingsBefore.length !== headingsAfter.length) return null
  const newAnchors = currentHeadingAnchors(after)
  // Section index → index after (same position among the headings).
  const afterIndexOf = new Map<number, number>()
  headingsBefore.forEach((s, i) => afterIndexOf.set(s.index, headingsAfter[i]?.index ?? -1))
  const indexOfOldId = new Map<string, number>()
  for (const [index, id] of currentHeadingAnchors(before)) indexOfOldId.set(id, index)
  return {
    indexOfOldId,
    newIdFor: (oldId) => {
      const index = indexOfOldId.get(oldId)
      if (index === undefined) return null
      const next = newAnchors.get(afterIndexOf.get(index) ?? -1)
      return next && next !== oldId ? next : null
    }
  }
}

/** The edit that puts the new section number into a link's text, or null. */
function labelEdit(linkStart: number, label: string, change: { from: string, to: string } | undefined): TextEdit | null {
  if (!change || change.from === change.to) return null
  const at = numberTokenAt(label, change.from)
  if (at === -1) return null
  // +1: the label starts after the `[`.
  return { start: linkStart + 1 + at, end: linkStart + 1 + at + change.from.length, text: change.to }
}

/**
 * Link edits for a change from `before` to `afterText` that keeps the same
 * headings in the same order (renamed or renumbered, none added or removed):
 * every link to a heading whose anchor changes is pointed at the new
 * anchor, and with `numberChanges` (section index → old / new number) the
 * old number in the link's text is replaced too. Offsets refer to
 * `before.text`. Links inside code are left alone.
 */
export function headingLinkEdits(
  before: DocumentStructure,
  afterText: string,
  numberChanges: ReadonlyMap<number, { from: string, to: string }> = new Map()
): LinkRetarget {
  const out: LinkRetarget = { edits: [], retargeted: 0, relabelled: 0 }
  const maps = anchorMaps(before, afterText)
  if (!maps) return out
  const masks = classifyMarkdownCached(before.text)
  const inCode = (start: number, end: number): boolean => {
    const r = overlappingRange(masks, start, end)
    return r !== null && CODE_MASK_CLASSES.has(r.cls)
  }
  const retarget = (m: RegExpMatchArray, id: string): void => {
    const next = maps.newIdFor(id)
    if (!next) return
    const idStart = (m.index ?? 0) + m[0].length - id.length
    out.edits.push({ start: idStart, end: idStart + id.length, text: next })
    out.retargeted++
  }

  for (const m of before.text.matchAll(INLINE_LINK_RE)) {
    const id = m[2] ?? ''
    if (inCode(m.index, m.index + m[0].length)) continue
    retarget(m, id)
    const index = maps.indexOfOldId.get(id)
    const label = labelEdit(m.index, m[1] ?? '', index === undefined ? undefined : numberChanges.get(index))
    if (label) {
      out.edits.push(label)
      out.relabelled++
    }
  }
  for (const m of before.text.matchAll(OTHER_TARGET_RE)) {
    if (!inCode(m.index, m.index + m[0].length)) retarget(m, m[1] ?? '')
  }
  return out
}

/** Apply non-overlapping edits (offsets in `text`) and return the new text. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const e of sorted) {
    out += text.slice(at, e.start) + e.text
    at = e.end
  }
  return out + text.slice(at)
}

/** Drop the edits that overlap one of `taken` (ranges another edit already changes). */
export function withoutOverlaps(edits: readonly TextEdit[], taken: ReadonlyArray<{ start: number, end: number }>): TextEdit[] {
  return edits.filter(e => !taken.some(t => e.start < t.end && t.start < e.end))
}

/** One sentence for a tool result: how many links followed the change. */
export function linkNote(r: LinkRetarget): string {
  const parts: string[] = []
  if (r.retargeted > 0) parts.push(`${r.retargeted} in-document link${r.retargeted === 1 ? '' : 's'} now point${r.retargeted === 1 ? 's' : ''} at the renamed heading's new anchor`)
  if (r.relabelled > 0) parts.push(`${r.relabelled} link text${r.relabelled === 1 ? '' : 's'} got the new section number`)
  return parts.length > 0 ? ` ${parts.join('; ')}.` : ''
}
