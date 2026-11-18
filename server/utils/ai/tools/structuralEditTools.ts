import { aiStatus } from '~~/shared/ai/statusSteps'
import { z } from 'zod'
import { defineDocTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import { blockSpacedInsertText, describeEditedRegion, lineShiftNote, newlineCount, numberedLines } from './documentText'
import type { DocToolContext } from '../../agentic/toolContext'
import { NO_OP_EDIT_ERROR_PREFIX } from '../../agentic/editProgress'
import { descendants, parseSections, sectionAtLine, sectionLabel, splitHeadingText, type DocumentStructure, type Section } from './sections/parse'
import { rebindSectionIds, resolveSection, sectionView, type SectionView } from './sections/sectionIds'
import { classifyMarkdownCached } from './sections/markdownMask'
import { describeSkipped } from './sections/search'
import { applyMinimalDiff } from './sections/ytextDiff'
import { commentAnchorsInRange, reanchorComments } from './sections/commentAnchors'
import { atxClosingStart, currentHeadingAnchors, isAtxHeading } from './sections/headingAnchors'
import { filterEmDashesAt, withoutEmDashes } from '../dashFilter'
import { headingPinsFor, planReplaceAll, type HeadingPin, type PlannedMatch } from './sections/replaceAll'

// Structural edits of the current document, addressed by section (ids from
// outline, numbers, heading text) instead of by copied text: replace,
// insert, move and delete sections, change a heading, replace a pattern
// everywhere, and a batch of line edits against one snapshot. Every call is
// ONE Y.js transaction tagged with the session origin (one change for
// collaborators, one activity-log edit), and rewrites go through
// `applyMinimalDiff`, so comment anchors and cursors on unchanged words stay.

const SectionRef = z.string().trim().min(1).max(300)
const SECTION_REF_HELP = 'An id from outline ("s-12"), a section number ("4.2") or the exact heading text.'
const Rev = z.string().trim().regex(/^[0-9a-f]{6}$/, 'a 6-character section rev from outline or read_section')

export const ReplaceSectionArgs = z.object({
  section: SectionRef.describe(`The section to rewrite. ${SECTION_REF_HELP}`),
  markdown: z.string().max(400_000)
    .describe('The new text. With keep_heading (default) everything under the heading, subsections included, without the heading line; otherwise the whole section starting with its heading.'),
  keep_heading: z.boolean().optional()
    .describe('true (default): keep the heading line and replace only what is under it.'),
  expected_rev: Rev.optional()
    .describe('The section rev you read it at; the edit is refused if the section changed since.')
}).describe('Replace the text of one section.')

export const InsertMarkdownArgs = z.object({
  markdown: z.string().min(1).max(400_000).describe('The Markdown to insert (blank lines around blocks are added).'),
  section: SectionRef.optional().describe(`The section to insert relative to (${SECTION_REF_HELP}). Without it: start or end of the document.`),
  position: z.enum(['start', 'end', 'before', 'after'])
    .describe('start: right after the heading line; end: at the end of the section (after its subsections); before / after: around the whole section.')
}).describe('Insert Markdown at a section boundary.')

export const MoveSectionArgs = z.object({
  section: SectionRef.describe(`The section to move, with its subsections. ${SECTION_REF_HELP}`),
  before: SectionRef.optional().describe('Move it right before this section.'),
  after: SectionRef.optional().describe('Move it right after this section (and its subsections).'),
  to_end: z.boolean().optional().describe('Move it to the end of the document.')
}).describe('Move a section with its subsections. Give exactly one of before, after, to_end.')

export const SwapSectionsArgs = z.object({
  a: SectionRef.describe(`One section. ${SECTION_REF_HELP}`),
  b: SectionRef.describe(`The other section; neither may contain the other. ${SECTION_REF_HELP}`)
}).describe('Swap two sections, each with its subsections.')

export const DeleteSectionArgs = z.object({
  section: SectionRef.describe(`The section to delete, with its subsections. ${SECTION_REF_HELP}`),
  expected_rev: Rev.optional().describe('The section rev you read it at; refused if the section changed since.')
}).describe('Delete a section with its subsections.')

export const SetHeadingArgs = z.object({
  section: SectionRef.describe(`The heading to change. ${SECTION_REF_HELP}`),
  level: z.number().int().min(1).max(6).optional().describe('New heading level 1-6 (subsections are not shifted).'),
  title: z.string().trim().min(1).max(300).optional().describe('New heading text, without # marks; include the number if the document numbers its headings ("4.2 Results").')
}).describe('Change a heading\'s level or text.')

export const ReplaceAllArgs = z.object({
  query: z.string().min(1).max(400).describe('Text to find, or a JavaScript regular expression when regex is true. Matches never span lines.'),
  replacement: z.string().max(2_000).describe('Replacement text. With regex, $1, $2 ... insert capture groups and $& the whole match.'),
  regex: z.boolean().optional().describe('Treat query as a regular expression (default false).'),
  caseSensitive: z.boolean().optional().describe('Match case exactly (default false).'),
  wholeWord: z.boolean().optional().describe('Only whole words (default false). "MyProduct" then still matches in "MyProduct\'s" but not in "MyProducts"; for plurals use regex "MyProduct(?=\'s|s\\\\b|\\\\b)" or "MyProduct(s?)\\\\b" with replacement "New$1".'),
  scope: SectionRef.optional().describe('A section to limit it to (subsections included), or "all" (default).'),
  excludeCode: z.boolean().optional().describe('Skip code blocks, inline code, math, HTML comments, front matter (default true).'),
  excludeUrls: z.boolean().optional().describe('Skip URLs, reference definitions and {#id} blocks (default true).'),
  excludeLinkTargets: z.boolean().optional().describe('Skip link and image targets, the (...) after [text] (default true). Link text is replaced.'),
  preview: z.boolean().optional().describe('true (default): only report what would change, with match ids. false: apply.'),
  matchIds: z.array(z.string().max(40)).min(1).max(2_000).optional()
    .describe('Apply only these matches, ids from the preview ("m3@1a2b3c4d"). Refused when the document changed since the preview.'),
  case: z.enum(['preserve', 'as_given']).optional()
    .describe('preserve (default): MYPRODUCT becomes upper case, myproduct lower case, a capitalised match a capitalised replacement; a match written like the query gets the replacement as given. as_given: always exactly the replacement.')
}).describe('Replace every occurrence of a text or pattern in the document, preview first.')

export const EditLinesArgs = z.object({
  base_rev: z.string().trim().regex(/^[0-9a-f]{8}$/, 'the 8-character doc rev').describe('The doc rev the line numbers refer to (outline, read_section or search_document show it).'),
  edits: z.array(z.object({
    start_line: z.number().int().min(1).describe('First line to replace (1-indexed).'),
    end_line: z.number().int().min(1).describe('Last line to replace (inclusive).'),
    expected_first_line: z.string().max(2_000).describe('The current text of start_line, copied without its number; the batch is refused if it differs.'),
    new_text: z.string().max(100_000).describe('Replacement lines (several lines allowed; empty string deletes the lines).')
  })).min(1).max(200).describe('The line edits, all numbered against base_rev; at most 200, no overlapping ranges.')
}).describe('Replace several line ranges at once, all numbered against one document rev.')

type Args<T extends z.ZodType> = z.output<T>

function originOf(ctx: DocToolContext): string {
  return `ai:assistant:${ctx.sessionId}`
}

const HEAD_PREVIEW_CHARS = 1_200

/** The first lines of a section, for the "changed since you read it" error. */
function sectionHead(structure: DocumentStructure, s: Section): string {
  return numberedLines(structure.lines, s.startLine, Math.min(s.endLine, s.startLine + 15), HEAD_PREVIEW_CHARS).text
}

function revMismatch(view: SectionView, s: Section, id: string, expected: string | undefined): ToolResult | null {
  if (!expected || expected === s.rev) return null
  return toolError(`Error: section ${id} changed since rev ${expected} (now rev ${s.rev}, lines ${s.startLine}-${s.endLine}); nothing was changed. Its start now reads:\n${sectionHead(view.structure, s)}\nRead it again with read_section and retry with expected_rev "${s.rev}".`)
}

/** Where the section stands after the edit: "Section s-12 "4.2 Results" now spans lines 40-58 (rev a1b2c3)." */
function sectionAfter(ctx: DocToolContext, id: string): string {
  const view = sectionView(ctx)
  const at = view.ids.indexOf(id)
  const s = view.structure.sections[at]
  if (!s) return ''
  return ` Section ${id} "${sectionLabel(s)}" now spans lines ${s.startLine}-${s.endLine} (rev ${s.rev}); doc rev ${view.structure.rev}.`
}

/** Line-shift note for an edit that turned [from, to) of `before` into `insertedLength` characters. */
function shiftNote(before: string, from: number, to: number, newText: string): string {
  if (to >= before.length && from >= before.length) return ''
  const removed = before.slice(from, to)
  const lastOldLine = lineAtOffsetOf(before, from) + newlineCount(removed) - (removed.endsWith('\n') ? 1 : 0)
  const note = lineShiftNote(Math.max(1, lastOldLine), newlineCount(newText) - newlineCount(removed))
  return note ? `\n${note}` : ''
}

function lineAtOffsetOf(text: string, offset: number): number {
  return newlineCount(text.slice(0, offset)) + 1
}

/** Offset just after a section's heading line(s). */
function afterHeading(structure: DocumentStructure, s: Section): number {
  return structure.lineOffsets[s.startLine - 1 + s.headingLines] ?? structure.text.length
}

/** Leading and trailing newlines of a range, kept around rewritten text so spacing does not churn. */
function edgeNewlines(text: string): { lead: number, trail: number } {
  let lead = 0
  while (text[lead] === '\n') lead++
  let trail = 0
  while (trail < text.length - lead && text[text.length - 1 - trail] === '\n') trail++
  return { lead, trail }
}

function trimTrailingNewlines(text: string): string {
  return text.slice(0, text.length - edgeNewlines(text).trail)
}

/** The block without blank lines in front and whitespace at the end. */
function trimBlock(markdown: string): string {
  const lines = markdown.split('\n')
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift()
  return lines.join('\n').trimEnd()
}

/** The new text of a replaced range, keeping the old range's spacing at both edges. */
function replacementText(old: string, body: string, keepHeading: boolean, followed: boolean): string {
  if (body === '') return followed ? '\n' : ''
  const edges = edgeNewlines(old)
  const lead = keepHeading ? '\n'.repeat(Math.max(1, edges.lead)) : ''
  const trail = followed ? '\n'.repeat(Math.max(2, edges.trail)) : '\n'
  return `${lead}${body}${trail}`
}

/** Whether Markdown starts with a heading line. */
function startsWithHeading(markdown: string): boolean {
  return parseSections(markdown).sections.some(s => s.level > 0 && s.startLine === 1)
}

// replace_section

function handleReplaceSection(ctx: DocToolContext, args: Args<typeof ReplaceSectionArgs>): ToolResult {
  const r = resolveSection(ctx, args.section)
  if (!r.ok) return toolError(r.error)
  const { view, section, id } = r
  const stale = revMismatch(view, section, id, args.expected_rev)
  if (stale) return stale
  const { structure } = view
  const keepHeading = (args.keep_heading ?? true) && section.level > 0
  const from = keepHeading ? afterHeading(structure, section) : section.startOffset
  const to = section.endOffset
  const old = structure.text.slice(from, to)
  const body = trimBlock(withoutEmDashes(args.markdown))
  if (!keepHeading && body === '') return toolError('Error: markdown is empty; use delete_section to remove a section.')
  const next = replacementText(old, body, keepHeading, to < structure.text.length)
  if (next === old) {
    return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: section ${id} already reads exactly like this. Do not repeat this call.`)
  }
  ctx.updateStatus('editing', aiStatus('editDocument'))
  ctx.ydoc.transact(() => {
    applyMinimalDiff(ctx.ytext, from, to, next)
  }, originOf(ctx))
  const after = ctx.ytext.toJSON()
  const replacedHeading = !keepHeading && !startsWithHeading(body) ? ' The new text does not start with a heading, so it now belongs to the section above.' : ''
  return toolOk(`Replaced ${keepHeading ? 'the text under the heading of' : ''} section ${id}.${replacedHeading}${sectionAfter(ctx, id)} ${describeEditedRegion(after, from, next.length)}${shiftNote(structure.text, from, to, next)}`)
}

// insert_markdown

function insertOffset(structure: DocumentStructure, section: Section | null, position: Args<typeof InsertMarkdownArgs>['position']): number | string {
  if (!section) {
    if (position === 'start') return 0
    if (position === 'end') return structure.text.length
    return `Error: position "${position}" needs a section.`
  }
  switch (position) {
    case 'start':
      return section.level === 0 ? section.startOffset : afterHeading(structure, section)
    case 'before':
      return section.startOffset
    case 'end':
    case 'after':
      return section.endOffset
  }
}

function handleInsertMarkdown(ctx: DocToolContext, args: Args<typeof InsertMarkdownArgs>): ToolResult {
  let structure: DocumentStructure
  let section: Section | null = null
  let id = ''
  if (args.section && args.section.toLowerCase() !== 'all') {
    const r = resolveSection(ctx, args.section)
    if (!r.ok) return toolError(r.error)
    section = r.section
    id = r.id
    structure = r.view.structure
  } else {
    structure = sectionView(ctx).structure
  }
  const at = insertOffset(structure, section, args.position)
  if (typeof at === 'string') return toolError(at)
  const text = blockSpacedInsertText(structure.text, at, withoutEmDashes(args.markdown))
  ctx.updateStatus('editing', aiStatus('applyInsert'))
  ctx.ydoc.transact(() => {
    ctx.ytext.insert(at, text)
  }, originOf(ctx))
  const where = section ? `${args.position === 'start' || args.position === 'end' ? 'at the ' + args.position + ' of' : args.position} section ${id} "${sectionLabel(section)}"` : `at the ${args.position} of the document`
  return toolOk(`Inserted ${where}. ${describeEditedRegion(ctx.ytext.toJSON(), at, text.length)}${shiftNote(structure.text, at, at, text)}`)
}

// move_section

/** Added to every move / swap result: headings keep their numbers. */
const RENUMBER_NOTE = 'Headings keep their numbers; renumber with set_heading (one heading) or replace_all with a regex (many), if the numbers must change.'

interface MoveTarget { section: Section, id: string, position: 'before' | 'after' }

function moveTarget(ctx: DocToolContext, args: Args<typeof MoveSectionArgs>): MoveTarget | 'end' | string {
  const given = [args.before, args.after, args.to_end ? 'end' : undefined].filter(v => v !== undefined)
  if (given.length !== 1) return 'Error: give exactly one of before, after or to_end.'
  if (args.to_end) return 'end'
  const r = resolveSection(ctx, args.before ?? args.after ?? '')
  if (!r.ok) return r.error
  // The preamble only has an "after" (before it is the start of the document).
  const position = args.before !== undefined && r.section.level > 0 ? 'before' : 'after'
  return { section: r.section, id: r.id, position }
}

/**
 * Where the moved text goes, resolved in the text AFTER the cut: the
 * target's heading start is mapped across the removed range and the
 * target is parsed again there, so its end (for "after") is its end
 * without the moved section, wherever the two lay.
 */
function cutInsertOffset(afterDelete: string, from: number, to: number, target: MoveTarget): number | string {
  const t = target.section
  if (t.level > 0 && t.startOffset >= from && t.startOffset < to) {
    return t.startOffset === from ? 'Error: a section cannot be moved relative to itself.' : `Error: ${target.id} lies inside the section being moved.`
  }
  const start = t.startOffset >= to ? t.startOffset - (to - from) : t.startOffset
  const cut = parseSections(afterDelete).sections.find(s => s.startOffset === start && s.level === t.level)
  if (!cut) return `Error: ${target.id} could not be found after removing the section; call outline and retry.`
  return target.position === 'before' ? cut.startOffset : cut.endOffset
}

function targetLabel(target: MoveTarget | 'end'): string {
  if (target === 'end') return 'to the end of the document'
  if (target.section.level === 0) return 'after the preamble'
  return `${target.position} ${target.id} "${sectionLabel(target.section)}"`
}

/** Section ids of a section and its subsections, by offset from the section start. */
function subtreeIds(view: SectionView, section: Section): Array<{ id: string, rel: number }> {
  return [section, ...descendants(view.structure, section)]
    .map(s => ({ id: view.ids[s.index] ?? '', rel: s.startOffset - section.startOffset }))
    .filter(e => e.id !== '')
}

function threadCount(n: number): string {
  return `${n} comment thread${n === 1 ? '' : 's'}`
}

function handleMoveSection(ctx: DocToolContext, args: Args<typeof MoveSectionArgs>): ToolResult {
  const r = resolveSection(ctx, args.section)
  if (!r.ok) return toolError(r.error)
  const { view, section, id } = r
  if (section.level === 0) return toolError('Error: the preamble (s-0) cannot be moved; move the sections around it instead.')
  const target = moveTarget(ctx, args)
  if (typeof target === 'string' && target !== 'end') return toolError(target)
  // Resolving the target parsed the same text, so `view` is still current.
  const { structure } = view
  const from = section.startOffset
  const to = section.endOffset
  const afterDelete = structure.text.slice(0, from) + structure.text.slice(to)
  const at = target === 'end' ? afterDelete.length : cutInsertOffset(afterDelete, from, to, target)
  if (typeof at === 'string') return toolError(at)
  if (at === from) return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: section ${id} is already ${targetLabel(target)}. Do not repeat this call.`)

  // The section's own trailing blank lines stay behind; block spacing at the target adds what is needed.
  const moved = `${trimTrailingNewlines(structure.text.slice(from, to))}\n`
  const ids = subtreeIds(view, section)
  const anchors = commentAnchorsInRange(ctx.ydoc, from, to)
  const insertion = blockSpacedInsertText(afterDelete, at, moved)
  const lead = insertion.length - insertion.replace(/^\n+/, '').length

  ctx.updateStatus('editing', aiStatus('editDocument'))
  ctx.ydoc.transact(() => {
    ctx.ytext.delete(from, to - from)
    ctx.ytext.insert(at, insertion)
    reanchorComments(ctx.ytext, anchors, at + lead)
  }, originOf(ctx))
  rebindSectionIds(ctx, ids.map(e => ({ id: e.id, offset: at + lead + e.rel })))

  const lines = newlineCount(moved)
  const comments = anchors.length > 0 ? ` ${threadCount(anchors.length)} moved with it.` : ''
  return toolOk(`Moved section ${id} "${sectionLabel(section)}" (${lines} lines, ${ids.length - 1} subsections) ${targetLabel(target)}.${comments}${sectionAfter(ctx, id)} Line numbers between the old and the new place changed; ids did not. ${RENUMBER_NOTE}`)
}

// swap_sections

/** The outline row of one section after an edit: id, heading, lines, rev. */
function outlineLine(ctx: DocToolContext, id: string): string {
  const view = sectionView(ctx)
  const s = view.structure.sections[view.ids.indexOf(id)]
  return s ? `${id}  ${'#'.repeat(s.level)} ${sectionLabel(s)}  [${s.startLine}-${s.endLine}]  rev ${s.rev}` : id
}

function handleSwapSections(ctx: DocToolContext, args: Args<typeof SwapSectionsArgs>): ToolResult {
  const ra = resolveSection(ctx, args.a)
  if (!ra.ok) return toolError(ra.error)
  const rb = resolveSection(ctx, args.b)
  if (!rb.ok) return toolError(rb.error)
  if (ra.section.level === 0 || rb.section.level === 0) return toolError('Error: the preamble (s-0) cannot be swapped; it has no heading.')
  if (ra.id === rb.id) return toolError('Error: a and b are the same section.')
  // Both resolutions parsed the same text.
  const view = rb.view
  const { structure } = view
  const [first, second] = ra.section.startOffset < rb.section.startOffset ? [ra, rb] : [rb, ra]
  const A = first.section
  const B = second.section
  if (B.startOffset < A.endOffset) {
    return toolError(`Error: ${second.id} "${sectionLabel(B)}" lies inside ${first.id} "${sectionLabel(A)}"; a section can only be swapped with one it does not contain. Swap sections of the same level (call outline).`)
  }
  // Each text without its trailing blank lines: those stay at the slot.
  const coreA = trimTrailingNewlines(structure.text.slice(A.startOffset, A.endOffset))
  const coreB = trimTrailingNewlines(structure.text.slice(B.startOffset, B.endOffset))
  const between = structure.text.slice(A.endOffset, B.startOffset)
  const idsA = subtreeIds(view, A)
  const idsB = subtreeIds(view, B)
  const anchorsA = commentAnchorsInRange(ctx.ydoc, A.startOffset, A.startOffset + coreA.length)
  const anchorsB = commentAnchorsInRange(ctx.ydoc, B.startOffset, B.startOffset + coreB.length)
  // B's text takes A's slot and A's text B's slot; each slot keeps its own trailing blank lines.
  const newBStart = A.startOffset
  const newAStart = A.endOffset - coreA.length + coreB.length + between.length

  ctx.updateStatus('editing', aiStatus('editDocument'))
  ctx.ydoc.transact(() => {
    // The later slot first, so A's offsets stay valid.
    ctx.ytext.delete(B.startOffset, coreB.length)
    ctx.ytext.insert(B.startOffset, coreA)
    ctx.ytext.delete(A.startOffset, coreA.length)
    ctx.ytext.insert(A.startOffset, coreB)
    reanchorComments(ctx.ytext, anchorsA, newAStart)
    reanchorComments(ctx.ytext, anchorsB, newBStart)
  }, originOf(ctx))
  rebindSectionIds(ctx, [
    ...idsA.map(e => ({ id: e.id, offset: newAStart + e.rel })),
    ...idsB.map(e => ({ id: e.id, offset: newBStart + e.rel }))
  ])

  const movedThreads = anchorsA.length + anchorsB.length
  const comments = movedThreads > 0 ? ` ${threadCount(movedThreads)} moved with them.` : ''
  const levels = A.level === B.level ? '' : ` The two headings have different levels (${'#'.repeat(A.level)} and ${'#'.repeat(B.level)}); check the outline.`
  return toolOk(`Swapped ${first.id} "${sectionLabel(A)}" and ${second.id} "${sectionLabel(B)}" in one edit, each with its subsections.${comments}${levels} Now:\n${outlineLine(ctx, second.id)}\n${outlineLine(ctx, first.id)}\nIds stayed with their sections; line numbers from ${A.startLine} to ${B.endLine} changed. ${RENUMBER_NOTE}`)
}

// delete_section

function handleDeleteSection(ctx: DocToolContext, args: Args<typeof DeleteSectionArgs>): ToolResult {
  const r = resolveSection(ctx, args.section)
  if (!r.ok) return toolError(r.error)
  const { view, section, id } = r
  const stale = revMismatch(view, section, id, args.expected_rev)
  if (stale) return stale
  const { structure } = view
  let from = section.startOffset
  const to = section.endOffset
  // At the end of the document, also drop the blank lines left above it.
  if (to >= structure.text.length) {
    while (from > 1 && structure.text[from - 1] === '\n' && structure.text[from - 2] === '\n') from--
  }
  const subs = descendants(structure, section).length
  ctx.updateStatus('editing', aiStatus('editDocument'))
  ctx.ydoc.transact(() => {
    ctx.ytext.delete(from, to - from)
  }, originOf(ctx))
  return toolOk(`Deleted section ${id} "${sectionLabel(section)}" (lines ${section.startLine}-${section.endLine}${subs > 0 ? `, ${subs} subsections` : ''}). ${describeEditedRegion(ctx.ytext.toJSON(), from, 0)}${shiftNote(structure.text, from, to, '')}`)
}

// set_heading

/** The text of an ATX heading line without its `#` marks and closing sequence. */
function atxHeadingContent(line: string): string {
  const closing = atxClosingStart(line)
  const body = closing === -1 ? line : line.slice(0, closing)
  return body.trimStart().replace(/^#{1,6}/, '').trim()
}

/** The heading's text line rebuilt with a new level and/or title (attribute block kept). */
function rebuiltHeading(structure: DocumentStructure, s: Section, level: number, title: string, pinId: string | null): string {
  const line = structure.lines[s.startLine - 1] ?? ''
  const atx = isAtxHeading(s)
  const content = atx ? atxHeadingContent(line) : line.trim()
  const split = splitHeadingText(content)
  let attr = split.title === content ? '' : content.slice(content.lastIndexOf('{'))
  if (pinId) attr = attr ? `{#${pinId} ${attr.slice(1)}` : `{#${pinId}}`
  const text = `${title}${attr ? ` ${attr}` : ''}`
  if (!atx && level <= 2) return `${text}\n${(level === 1 ? '=' : '-').repeat(Math.max(3, Math.min(title.length, 80)))}`
  return `${'#'.repeat(level)} ${text}`
}

function handleSetHeading(ctx: DocToolContext, args: Args<typeof SetHeadingArgs>): ToolResult {
  if (args.level === undefined && args.title === undefined) return toolError('Error: give level, title or both.')
  const r = resolveSection(ctx, args.section)
  if (!r.ok) return toolError(r.error)
  const { view, section, id } = r
  if (section.level === 0) return toolError('Error: the preamble (s-0) has no heading. Use insert_markdown with position "start" to add one.')
  const { structure } = view
  const level = args.level ?? section.level
  const title = args.title === undefined ? section.title : withoutEmDashes(args.title)
  const titleChanged = title !== section.title
  const pinId = titleChanged && section.explicitId === null ? currentHeadingAnchors(structure).get(section.index) ?? null : null
  const next = rebuiltHeading(structure, section, level, title, pinId)
  const from = section.startOffset
  const lastLine = section.startLine + section.headingLines - 1
  const to = (structure.lineOffsets[lastLine - 1] ?? 0) + (structure.lines[lastLine - 1] ?? '').length
  if (structure.text.slice(from, to) === next) {
    return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: the heading already reads "${next.split('\n')[0]}". Do not repeat this call.`)
  }
  ctx.updateStatus('editing', aiStatus('editDocument'))
  ctx.ydoc.transact(() => {
    applyMinimalDiff(ctx.ytext, from, to, next)
  }, originOf(ctx))
  const pinned = pinId ? ` The old anchor is kept as {#${pinId}}, so links to it still work.` : ''
  return toolOk(`Heading of section ${id} now reads: ${next.split('\n')[0]}${pinned}${sectionAfter(ctx, id)}`)
}

// replace_all

const PREVIEW_ROWS = 12
const DIFF_CONTEXT = 40

function diffRow(structure: DocumentStructure, view: SectionView, m: PlannedMatch, rev: string): string {
  const line = structure.lines[m.line - 1] ?? ''
  const col = m.start - (structure.lineOffsets[m.line - 1] ?? 0)
  const from = Math.max(0, col - DIFF_CONTEXT)
  const to = Math.min(line.length, col + m.before.length + DIFF_CONTEXT)
  const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s)
  const sec = sectionAtLine(structure, m.line)
  const where = sec ? view.ids[sec.index] ?? '-' : '-'
  return `m${m.k}@${rev}  line ${m.line}  ${where}  ${from > 0 ? '…' : ''}${line.slice(from, col)}«${clip(m.before)}» → «${clip(m.after)}»${line.slice(col + m.before.length, to)}${to < line.length ? '…' : ''}`
}

function flagsText(args: Args<typeof ReplaceAllArgs>): string {
  return [args.regex ? 'regex' : null, args.wholeWord ? 'whole word' : null, args.caseSensitive ? 'case-sensitive' : 'any case', `case ${args.case ?? 'preserve'}`].filter(Boolean).join(', ')
}

/** The matches named by `matchIds`, or an error (unknown or stale ids). */
function selectMatches(ids: readonly string[], matches: readonly PlannedMatch[], rev: string): PlannedMatch[] | string {
  const wanted = new Set<number>()
  for (const raw of ids) {
    const m = /^m(\d{1,6})@([0-9a-f]{8})$/.exec(raw.trim())
    if (!m) return `Error: "${raw}" is not a match id; use the ids from the replace_all preview, like "m3@${rev}".`
    if (m[2] !== rev) return `Error: match ids are from doc rev ${m[2]}, but the document changed since (now rev ${rev}); nothing was replaced. Call replace_all with preview true again and use the new ids.`
    const k = Number(m[1])
    if (k < 1 || k > matches.length) return `Error: ${raw} does not exist; the preview has m1-m${matches.length}.`
    wanted.add(k)
  }
  return matches.filter(m => wanted.has(m.k))
}

interface Edit { start: number, end: number, text: string }

function applyEdits(ctx: DocToolContext, edits: Edit[]): void {
  // Back to front, so earlier offsets stay valid; at one offset an insertion
  // (a heading pin at a match's end) goes first.
  const sorted = [...edits].sort((a, b) => b.start - a.start || (a.end - a.start) - (b.end - b.start))
  ctx.ydoc.transact(() => {
    for (const e of sorted) applyMinimalDiff(ctx.ytext, e.start, e.end, e.text)
  }, originOf(ctx))
}

function pinNote(pins: readonly HeadingPin[]): string {
  if (pins.length === 0) return ''
  const list = pins.slice(0, 5).map(p => `{#${p.id}} (line ${p.line})`).join(', ')
  return ` ${pins.length} renamed heading${pins.length === 1 ? '' : 's'} keep${pins.length === 1 ? 's' : ''} the old anchor as an explicit id: ${list}${pins.length > 5 ? ', ...' : ''}.`
}

interface ReplaceAllContext {
  ctx: DocToolContext
  args: Args<typeof ReplaceAllArgs>
  view: SectionView
  matches: PlannedMatch[]
  changes: PlannedMatch[]
  unchanged: number
  pins: HeadingPin[]
  head: string
  notTouched: string
}

function previewReplaceAll(c: ReplaceAllContext): ToolResult {
  const { structure } = c.view
  const rows = c.changes.slice(0, PREVIEW_ROWS).map(m => diffRow(structure, c.view, m, structure.rev))
  const parts = [
    `Preview, nothing changed yet. ${c.head} ${c.changes.length} would change${c.unchanged > 0 ? `, ${c.unchanged} already read so` : ''}.${pinNote(c.pins)}`,
    ...rows
  ]
  if (c.changes.length > PREVIEW_ROWS) parts.push(`(first ${PREVIEW_ROWS} of ${c.changes.length} shown; the rest are m-ids in document order, same rev)`)
  parts.push('Apply all: the same call with preview false. Apply some: add matchIds with the ids to replace. Wrong hits: tighten the query (wholeWord, caseSensitive, regex, scope) and preview again.')
  return toolOk(parts.join('\n'))
}

function applyReplaceAll(c: ReplaceAllContext): ToolResult {
  const { ctx, args, changes, pins } = c
  if (changes.length === 0) {
    return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: every selected match already reads like its replacement. Do not repeat this call.`)
  }
  ctx.updateStatus('editing', aiStatus('editDocument'))
  applyEdits(ctx, [
    ...changes.map(m => ({ start: m.start, end: m.end, text: m.after })),
    ...pins.map(p => ({ start: p.offset, end: p.offset, text: p.text }))
  ])
  const lines = [...new Set(changes.map(m => m.line))]
  const lineList = `${lines.slice(0, 20).join(', ')}${lines.length > 20 ? ', ...' : ''}`
  const shift = changes.reduce((n, m) => n + newlineCount(m.after) - newlineCount(m.before), 0)
  const shiftText = shift === 0 ? '' : ` Line numbers after line ${lines[0]} shifted; read again before line-based edits.`
  const plural = changes.length === 1 ? '' : 's'
  return {
    ...toolOk(`Replaced ${changes.length} occurrence${plural} of "${args.query}" in one edit (lines ${lineList}); doc rev now ${sectionView(ctx).structure.rev}.${c.notTouched}${pinNote(pins)}${shiftText}`),
    activity: { kind: 'ai.tool', tool: 'replace_all', query: args.query.slice(0, 200), replacement: args.replacement.slice(0, 200), count: changes.length }
  }
}

function scopeView(ctx: DocToolContext, scope: string | undefined): { ok: true, view: SectionView, section: Section | null, id: string } | { ok: false, error: string } {
  const ref = scope?.trim()
  if (!ref || ref.toLowerCase() === 'all') return { ok: true, view: sectionView(ctx), section: null, id: '' }
  return resolveSection(ctx, ref)
}

function handleReplaceAll(ctx: DocToolContext, given: Args<typeof ReplaceAllArgs>): ToolResult {
  // The replacement is AI-written text; it is only filtered when code is excluded (a code match keeps what was asked for).
  const args = given.excludeCode === false ? given : { ...given, replacement: withoutEmDashes(given.replacement) }
  const r = scopeView(ctx, args.scope)
  if (!r.ok) return toolError(r.error)
  const { view, section: scope } = r
  const { structure } = view
  const planned = planReplaceAll(structure, classifyMarkdownCached(structure.text), args, scope ? { startLine: scope.startLine, endLine: scope.endLine } : {})
  if (!planned.ok) return toolError(planned.error)
  const { matches, skipped, truncated } = planned.plan
  const where = scope ? `section ${r.id} "${sectionLabel(scope)}"` : 'the whole document'
  const skippedText = describeSkipped(skipped)
  const notTouched = skippedText ? ` Not touched: ${skippedText}.` : ''
  if (truncated) return toolError(`Error: more than ${matches.length} matches for "${args.query}"; narrow the query or the scope.`)
  if (matches.length === 0) {
    const tip = args.wholeWord || args.caseSensitive ? ' Try without wholeWord / caseSensitive, or a regex for word forms.' : ''
    return toolOk(`No match for "${args.query}" (${flagsText(args)}) in ${where}; doc rev ${structure.rev}.${notTouched}${tip}`)
  }
  const selected = args.matchIds ? selectMatches(args.matchIds, matches, structure.rev) : matches
  if (typeof selected === 'string') return toolError(selected)
  const changes = selected.filter(m => m.before !== m.after)
  const c: ReplaceAllContext = {
    ctx,
    args,
    view,
    matches,
    changes,
    unchanged: selected.length - changes.length,
    pins: headingPinsFor(structure, changes),
    head: `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${args.query}" (${flagsText(args)}) in ${where}; doc rev ${structure.rev}.${notTouched}`,
    notTouched
  }
  return (args.preview ?? true) ? previewReplaceAll(c) : applyReplaceAll(c)
}

// edit_lines

interface LineEdit { start: number, end: number, text: string, startLine: number, endLine: number, newLines: number }

function lineEditProblem(structure: DocumentStructure, e: Args<typeof EditLinesArgs>['edits'][number], prevEnd: number): string | null {
  const total = structure.lines.length
  if (e.end_line < e.start_line) return `Error: edit at line ${e.start_line}: end_line is before start_line.`
  if (e.end_line > total) return `Error: edit at line ${e.start_line}: end_line ${e.end_line} is past the last line (${total}).`
  if (e.start_line <= prevEnd) return `Error: edits at lines ${e.start_line} and before overlap; each line may be edited once per batch.`
  const current = structure.lines[e.start_line - 1] ?? ''
  if (current.trimEnd() === e.expected_first_line.trimEnd()) return null
  return `Error: line ${e.start_line} reads ${JSON.stringify(current.slice(0, 200))}, not ${JSON.stringify(e.expected_first_line.slice(0, 200))}; nothing was changed. Read the lines again.`
}

function planLineEdits(structure: DocumentStructure, edits: Args<typeof EditLinesArgs>['edits']): LineEdit[] | string {
  const total = structure.lines.length
  const sorted = [...edits].sort((a, b) => a.start_line - b.start_line)
  const out: LineEdit[] = []
  let prevEnd = 0
  for (const e of sorted) {
    const problem = lineEditProblem(structure, e, prevEnd)
    if (problem) return problem
    prevEnd = e.end_line
    const start = structure.lineOffsets[e.start_line - 1] ?? 0
    const lineEnd = (structure.lineOffsets[e.end_line - 1] ?? 0) + (structure.lines[e.end_line - 1] ?? '').length
    const body = filterEmDashesAt(structure.text, start, e.new_text.replace(/\n$/, ''))
    if (e.new_text === '') {
      // Delete the lines with their line break (the one before, for the last line).
      const lastLine = e.end_line === total
      const s = lastLine && start > 0 ? start - 1 : start
      const end = lastLine ? lineEnd : lineEnd + 1
      out.push({ start: s, end, text: '', startLine: e.start_line, endLine: e.end_line, newLines: 0 })
    } else {
      out.push({ start, end: lineEnd, text: body, startLine: e.start_line, endLine: e.end_line, newLines: newlineCount(body) + 1 })
    }
  }
  return out
}

/** Where each edit landed, counted top-down with the shifts above it, and the total shift. */
function landedRanges(plan: readonly LineEdit[]): { landed: string[], shift: number } {
  let shift = 0
  const landed = plan.map((e) => {
    const from = e.startLine + shift
    shift += e.newLines - (e.endLine - e.startLine + 1)
    return e.newLines === 0 ? `lines ${e.startLine}-${e.endLine} deleted` : `lines ${e.startLine}-${e.endLine} → now ${from}-${from + e.newLines - 1}`
  })
  return { landed, shift }
}

function handleEditLines(ctx: DocToolContext, args: Args<typeof EditLinesArgs>): ToolResult {
  const view = sectionView(ctx)
  const { structure } = view
  if (args.base_rev !== structure.rev) {
    return toolError(`Error: the document changed since rev ${args.base_rev} (now rev ${structure.rev}); nothing was changed. Line numbers may have moved: read the lines again and send the batch with base_rev "${structure.rev}".`)
  }
  const plan = planLineEdits(structure, args.edits)
  if (typeof plan === 'string') return toolError(plan)
  const changed = plan.filter(e => structure.text.slice(e.start, e.end) !== e.text)
  if (changed.length === 0) return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: every edit already reads like its new_text. Do not repeat this call.`)
  ctx.updateStatus('editing', aiStatus('editDocument'))
  ctx.ydoc.transact(() => {
    for (const e of [...changed].reverse()) applyMinimalDiff(ctx.ytext, e.start, e.end, e.text)
  }, originOf(ctx))
  const { landed, shift } = landedRanges(plan)
  const after = sectionView(ctx).structure.rev
  const tail = shift !== 0 ? ` Lines after line ${plan.at(-1)?.endLine} shifted by ${shift > 0 ? '+' : ''}${shift}.` : ''
  return toolOk(`Applied ${changed.length} of ${plan.length} line edits in one change: ${landed.slice(0, 30).join('; ')}${landed.length > 30 ? '; ...' : ''}. Doc rev now ${after}.${tail}`)
}

// Definitions

export const replaceSectionTool = defineDocTool({
  name: 'replace_section',
  description: 'Rewrite one section by id ("s-12"), number or heading: give the new text for everything under its heading (subsections included); the heading line stays unless keep_heading is false. Only changed words are touched, so comments on unchanged text survive. Pass expected_rev from outline / read_section to refuse the edit if someone changed the section meanwhile. For a single sentence use replace_text.',
  schema: ReplaceSectionArgs,
  handler: handleReplaceSection
})

export const insertMarkdownTool = defineDocTool({
  name: 'insert_markdown',
  description: 'Insert Markdown relative to a section: start (right after its heading), end (after its last subsection), before or after the whole section; without a section, at the start or end of the document. Blank lines around blocks are added. Use it to add a paragraph, table, list or new section without counting lines.',
  schema: InsertMarkdownArgs,
  handler: handleInsertMarkdown
})

export const moveSectionTool = defineDocTool({
  name: 'move_section',
  description: 'Move a section with its subsections before or after another section, or to the end of the document, in one step on the server (no text to copy). Comments inside it move along; section ids stay valid, and the target is found again after the section is cut out, so ids from one outline still work for the next move. Example: to move chapter 15 before chapter 10, move_section({section: "s-15", before: "s-10"}). To swap two chapters use swap_sections, not two moves. Headings keep their numbers (renumber with set_heading or replace_all).',
  schema: MoveSectionArgs,
  handler: handleMoveSection
})

export const swapSectionsTool = defineDocTool({
  name: 'swap_sections',
  description: 'Swap two sections, each with its subsections, in one edit on the server, adjacent or far apart: to swap chapters 10 and 15, swap_sections({a: "s-10", b: "s-15"}). Refused when one section contains the other. Comments inside both move along; ids stay with their sections. Returns the two sections\' new outline lines. Headings keep their numbers (renumber with set_heading or replace_all).',
  schema: SwapSectionsArgs,
  handler: handleSwapSections
})

export const deleteSectionTool = defineDocTool({
  name: 'delete_section',
  description: 'Delete a section with its subsections. Pass expected_rev to refuse if it changed since you read it.',
  schema: DeleteSectionArgs,
  handler: handleDeleteSection
})

export const setHeadingTool = defineDocTool({
  name: 'set_heading',
  description: 'Change a heading\'s level (1-6) and/or text without retyping the section. Its {#id} attribute block is kept; when the text changes, the old anchor is pinned as an explicit id so links keep working. Subsection levels do not shift. The only H1 is the document\'s title: demote any other H1 to level 2 (and its subsections one level each), keep levels in order.',
  schema: SetHeadingArgs,
  handler: handleSetHeading
})

export const replaceAllTool = defineDocTool({
  name: 'replace_all',
  description: 'Replace every occurrence of a word, phrase or pattern in the document in one edit. First call previews (preview defaults to true): total count, skipped counts (code, math, URLs, link targets are left alone by default), the first diffs and match ids; then call again with preview false, optionally with matchIds to apply only some. Case is preserved by default (MYPRODUCT → MYNEWNAME). Renamed headings keep their old anchor. Use it for a deterministic change (rename a product, fix a recurring typo, change a URL); for one spot use replace_text; when the change needs grammar or judgement (German "Kunde" → "Klient" with articles and endings), use delegate_rewrite in terminology mode or per-occurrence edits.',
  schema: ReplaceAllArgs,
  handler: handleReplaceAll
})

export const editLinesTool = defineDocTool({
  name: 'edit_lines',
  description: 'Replace several line ranges in one call, all numbered against the same doc rev (base_rev from outline, read_section or search_document): the batch is applied bottom-up so the numbers you read stay valid, and refused if the document changed or a line\'s expected_first_line does not match. Use it for many small fixes you located by line (typos, heading levels, list items).',
  schema: EditLinesArgs,
  handler: handleEditLines
})
