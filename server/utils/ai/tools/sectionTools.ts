import { z } from 'zod'
import { defineDocTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import { numberedLines } from './documentText'
import { TOOL_RESULT_CHAR_CAP } from '../../agentic/limits'
import type { DocToolContext } from '../../agentic/toolContext'
import { descendants, sectionAtLine, sectionLabel, type DocumentStructure, type Section } from './sections/parse'
import { resolveSection, sectionView, type SectionView } from './sections/sectionIds'
import { classifyMarkdownCached } from './sections/markdownMask'
import { describeSkipped, MAX_COLLECTED_MATCHES, searchLines, type SearchMatch } from './sections/search'

// Section-addressed reading of the current document: outline (ids, numbers,
// sizes), read_section and search_document. Ids come from
// `sections/sectionIds.ts` and survive edits; view_document stays the path
// for short documents and exact line ranges.

/** Room the results get: below the loop's cap, so the tools' own continuation hints are what the model reads. */
const RESULT_BUDGET = TOOL_RESULT_CHAR_CAP - 2_000

/** Above this size the outline tells the model how to handle document-wide rewrites. */
const LARGE_DOCUMENT_TOKENS = 12_000

const SectionRef = z.string().trim().min(1).max(300)

export const OutlineArgs = z.object({
  depth: z.number().int().min(1).max(6).optional()
    .describe('Heading levels to list, counted from the top (or from `under`). Default 3.'),
  under: SectionRef.optional()
    .describe('Only this section and its subsections: an id from outline ("s-12"), a section number ("4.2") or the heading text.')
}).describe('List the sections of the current document with ids, numbers, line ranges and sizes.')

export const ReadSectionArgs = z.object({
  section: SectionRef
    .describe('The section: an id from outline ("s-12"), a section number ("4.2") or the exact heading text.'),
  include_subsections: z.boolean().optional()
    .describe('true (default): the whole subtree; false: only the text up to the first subsection.'),
  offset_line: z.number().int().min(1).optional()
    .describe('Start reading at this line (from a continuation hint) instead of the section start.'),
  max_chars: z.number().int().min(1_000).max(RESULT_BUDGET).optional()
    .describe(`Most characters to return (default 20000, at most ${RESULT_BUDGET}).`)
}).describe('Read one section of the current document with line numbers.')

export const SearchDocumentArgs = z.object({
  query: z.string().min(1).max(400)
    .describe('Text to find, or a JavaScript regular expression when regex is true. Matches never span lines.'),
  regex: z.boolean().optional()
    .describe('Treat query as a regular expression (default false). Capture groups are listed with each match.'),
  caseSensitive: z.boolean().optional()
    .describe('Match upper and lower case exactly (default false).'),
  wholeWord: z.boolean().optional()
    .describe('Only matches that are whole words, not parts of longer words (default false).'),
  scope: SectionRef.optional()
    .describe('A section to search in (id, number or heading text, subsections included), or "all" (default).'),
  excludeCode: z.boolean().optional()
    .describe('Skip code blocks, inline code, math, HTML comments and front matter (default true).'),
  excludeUrls: z.boolean().optional()
    .describe('Skip link and image targets, URLs, reference definitions and {#id} attribute blocks (default true). Link text is still searched.'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Matches to list in this result (default 30, at most 200).'),
  cursor: z.string().max(40).optional()
    .describe('The cursor from the previous result, to list the next matches.')
}).describe('Find text in the current document.')

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** The heading as the outline shows it: level marks, title without a written number (the number column has it), anchor id. */
function outlineHeading(s: Section): string {
  if (s.level === 0) return '(preamble)'
  const title = s.numberIsLiteral ? s.bareTitle : s.title
  return `${'#'.repeat(s.level)} ${title}${s.explicitId ? ` {#${s.explicitId}}` : ''}`
}

function outlineRow(view: SectionView, s: Section): string {
  const range = s.startLine === s.endLine ? `[${s.startLine}]` : `[${s.startLine}-${s.endLine}]`
  const num = s.level === 0 ? '-' : s.number
  return `${view.ids[s.index]}  ${num}  ${outlineHeading(s)}  ${range}  ${s.words} words  ${s.rev}`
}

/** "more than one H1 (s-3, s-9): ..." when the document has several H1 headings, else null. */
function multipleH1Warning(view: SectionView): string | null {
  const h1 = view.structure.sections.filter(s => s.level === 1)
  if (h1.length < 2) return null
  const ids = h1.slice(0, 8).map(s => view.ids[s.index]).join(', ')
  return `more than one H1 (${ids}${h1.length > 8 ? ', ...' : ''}): the document title is the only H1; when you fix headings, make the others H2 (and their subsections one level lower)`
}

/** The outline's warnings line (level jumps in scope, a second H1 on the whole outline), or ''. */
function outlineWarnings(view: SectionView, under: Section | undefined): string {
  const { structure } = view
  const lineOf = (w: string): number => Number(/at line (\d+)$/.exec(w)?.[1])
  const warnings = structure.warnings
    .filter(w => !under || (lineOf(w) >= under.startLine && lineOf(w) <= under.endLine))
    .map((w) => {
      const s = sectionAtLine(structure, lineOf(w))
      return s ? `${w} (${view.ids[s.index]})` : w
    })
  // A document-wide warning: only on the whole outline.
  const h1 = under ? null : multipleH1Warning(view)
  if (h1) warnings.unshift(h1)
  if (warnings.length === 0) return ''
  return `\nWarnings: ${warnings.slice(0, 5).join('; ')}${warnings.length > 5 ? `; and ${warnings.length - 5} more` : ''}`
}

/** One line on what to do with a large document, from the server's thresholds. */
function delegateHint(structure: DocumentStructure): string | null {
  const tokens = structure.totals.tokens
  if (tokens <= LARGE_DOCUMENT_TOKENS) return null
  return `delegate_hint: This document is large (${fmt(tokens)} tokens). For document-wide rule-like rewrites (translate, tone, terminology) use delegate_rewrite; for an exact pattern use search_document + replace_all.`
}

/** The outline as text, as deep as `depth` allows and the budget fits. */
function formatSectionOutline(view: SectionView, opts: { depth: number, under?: Section, budget: number }): string {
  const { structure } = view
  const t = structure.totals
  const head = [`Document: ${fmt(t.lines)} lines, ${fmt(t.words)} words, about ${fmt(t.tokens)} tokens, ${structure.sections.filter(s => s.level > 0).length} headings (rev ${structure.rev}).`]
  const hint = delegateHint(structure)
  if (hint) head.push(hint)

  const scope = opts.under ? [opts.under, ...descendants(structure, opts.under)] : structure.sections
  const base = opts.under ? opts.under.level : 1
  if (opts.under) head.push(`Under ${view.ids[opts.under.index]} "${sectionLabel(opts.under)}":`)
  head.push('id  number  heading  [lines]  words  rev')

  const warningText = outlineWarnings(view, opts.under)
  const headText = head.join('\n')
  for (let depth = Math.min(6, opts.depth); depth >= 1; depth--) {
    const maxLevel = base + depth - 1
    const shown = scope.filter(s => s.level <= maxLevel)
    const rows = shown.map(s => outlineRow(view, s)).join('\n')
    const omitted = scope.length - shown.length
    const tail = omitted > 0 ? `\n(${omitted} deeper headings not listed; call outline with a larger depth, or with under set to a section.)` : ''
    const text = `${headText}\n${rows}${warningText}${tail}`
    if (text.length <= opts.budget || depth === 1) {
      if (text.length <= opts.budget) return text
      const cut = text.lastIndexOf('\n', opts.budget - 120)
      return `${text.slice(0, cut)}\n[outline cut at the size limit; call outline with under set to a section to see the rest.]`
    }
  }
  return headText
}

/** The current section view, and the section `ref` names when there is one ("all" / none: the whole document). */
function viewFor(ctx: DocToolContext, ref: string | undefined): { ok: true, view: SectionView, section: Section | null, id: string } | { ok: false, error: string } {
  const wanted = ref?.trim()
  if (!wanted || wanted.toLowerCase() === 'all') return { ok: true, view: sectionView(ctx), section: null, id: '' }
  return resolveSection(ctx, wanted)
}

function handleOutline(ctx: DocToolContext, args: z.output<typeof OutlineArgs>): ToolResult {
  const r = viewFor(ctx, args.under)
  if (!r.ok) return toolError(r.error)
  const { structure } = r.view
  if (!structure.sections.some(s => s.level > 0)) {
    const t = structure.totals
    return toolOk(`Document: ${fmt(t.lines)} lines, ${fmt(t.words)} words, about ${fmt(t.tokens)} tokens. It has no headings; read it with view_document.`)
  }
  return toolOk(formatSectionOutline(r.view, { depth: args.depth ?? 3, under: r.section ?? undefined, budget: RESULT_BUDGET }))
}

/** "; 4 subsections included" or "; subsections not included: s-3, s-4", for the read_section header. */
function subsectionNote(view: SectionView, section: Section, withSubs: boolean): string {
  const subs = descendants(view.structure, section)
  if (subs.length === 0) return ''
  if (withSubs) return `; ${subs.length} subsection${subs.length === 1 ? '' : 's'} included`
  return `; subsections not included: ${subs.filter(s => s.parent === section.index).map(s => view.ids[s.index]).join(', ')}`
}

function handleReadSection(ctx: DocToolContext, args: z.output<typeof ReadSectionArgs>): ToolResult {
  const r = resolveSection(ctx, args.section)
  if (!r.ok) return toolError(r.error)
  const { section, id, view } = r
  const withSubs = args.include_subsections ?? true
  const last = withSubs ? section.endLine : section.bodyEndLine
  const from = args.offset_line ?? section.startLine
  if (from < section.startLine || from > last) {
    return toolError(`Error: offset_line ${from} is outside section ${id} (lines ${section.startLine}-${last}).`)
  }
  const budget = Math.min(args.max_chars ?? 20_000, RESULT_BUDGET)
  const header = `Section ${id} "${sectionLabel(section)}" (lines ${section.startLine}-${last}, rev ${section.rev}, ${fmt(section.words)} words${subsectionNote(view, section, withSubs)}; doc rev ${view.structure.rev})`
  const shown = numberedLines(view.structure.lines, from, last, Math.max(500, budget - header.length - 200))
  if (!shown.cut) return toolOk(`${header}\n${shown.text}`)
  const next = shown.lastLine + 1
  const hint = next <= last
    ? `[Shown: lines ${from}-${shown.lastLine} of ${section.startLine}-${last} (result size limit). Continue with read_section section "${id}" and offset_line ${next}.]`
    : `[Line ${shown.lastLine} is longer than one result allows and was cut.]`
  return toolOk(`${header}\n${shown.text}\n\n${hint}`)
}

const SNIPPET_CONTEXT = 50

/** The match in its line, marked with « », with up to SNIPPET_CONTEXT characters on each side. */
function snippet(structure: DocumentStructure, m: SearchMatch): string {
  const line = structure.lines[m.line - 1] ?? ''
  const col = m.start - (structure.lineOffsets[m.line - 1] ?? 0)
  const from = Math.max(0, col - SNIPPET_CONTEXT)
  const to = Math.min(line.length, col + m.text.length + SNIPPET_CONTEXT)
  const matched = m.text.length > 120 ? `${m.text.slice(0, 117)}...` : m.text
  return `${from > 0 ? '…' : ''}${line.slice(from, col)}«${matched}»${line.slice(col + m.text.length, to)}${to < line.length ? '…' : ''}`
}

/** A cursor is "<matches already listed>:<doc rev>". */
function parseCursor(cursor: string | undefined): { offset: number, rev: string | null } {
  const [count = '', rev] = (cursor ?? '').trim().split(':')
  if (!/^\d{1,6}$/.test(count)) return { offset: 0, rev: null }
  return { offset: Number(count), rev: rev && /^[0-9a-f]{8}$/.test(rev) ? rev : null }
}

function searchFlags(args: z.output<typeof SearchDocumentArgs>): string {
  const flags = [args.regex ? 'regex' : null, args.wholeWord ? 'whole word' : null, args.caseSensitive ? 'case-sensitive' : 'any case']
  return flags.filter(Boolean).join(', ')
}

function matchRow(view: SectionView, m: SearchMatch, k: number): string {
  const sec = sectionAtLine(view.structure, m.line)
  const where = sec ? `${view.ids[sec.index]} ${sec.headingPath}` : '-'
  const groups = m.groups.length > 0 ? `  groups: ${m.groups.map(g => JSON.stringify(g.length > 60 ? `${g.slice(0, 57)}...` : g)).join(', ')}` : ''
  return `m${k + 1}  line ${m.line}  ${where}  ${snippet(view.structure, m)}${groups}`
}

/** Rows of matches from `offset`, at most `limit`, within the result budget; returns them and where the next page starts. */
function matchRows(view: SectionView, matches: readonly SearchMatch[], offset: number, limit: number, used: number): { rows: string[], next: number } {
  const rows: string[] = []
  let size = used
  let next = offset
  for (const m of matches.slice(offset, offset + limit)) {
    const row = matchRow(view, m, next)
    if (size + row.length + 1 > RESULT_BUDGET && rows.length > 0) break
    rows.push(row)
    size += row.length + 1
    next += 1
  }
  return { rows, next }
}

function handleSearchDocument(ctx: DocToolContext, args: z.output<typeof SearchDocumentArgs>): ToolResult {
  const r = viewFor(ctx, args.scope)
  if (!r.ok) return toolError(r.error)
  const { view, section: scope } = r
  const { structure } = view
  const run = searchLines(structure, classifyMarkdownCached(structure.text), args, scope ? { startLine: scope.startLine, endLine: scope.endLine } : {})
  if (!run.ok) return toolError(run.error)
  const { matches, skipped, truncated } = run.outcome

  const where = scope ? `section ${r.id} "${sectionLabel(scope)}" (lines ${scope.startLine}-${scope.endLine})` : 'the whole document'
  const total = truncated ? `more than ${MAX_COLLECTED_MATCHES}` : String(matches.length)
  const skippedText = describeSkipped(skipped)
  const header = `${total} match${matches.length === 1 && !truncated ? '' : 'es'} for "${args.query}" (${searchFlags(args)}) in ${where}; doc rev ${structure.rev}.${skippedText ? ` Not counted: ${skippedText}.` : ''}`
  if (matches.length === 0) {
    const tips = args.wholeWord || args.caseSensitive ? ' Try without wholeWord / caseSensitive, or with regex for word forms.' : ''
    return toolOk(`${header}${tips}`)
  }

  const cursor = parseCursor(args.cursor)
  const offset = Math.min(cursor.offset, matches.length)
  const { rows, next } = matchRows(view, matches, offset, args.limit ?? 30, header.length + 200)
  const parts = [header]
  if (cursor.rev !== null && cursor.rev !== structure.rev) parts.push('(The document changed since the previous page; match numbers are counted on the current text.)')
  parts.push(`Matches m${offset + 1}-m${next}:`, ...rows)
  if (next < matches.length) parts.push(`More: call search_document with the same arguments and cursor "${next}:${structure.rev}".`)
  return toolOk(parts.join('\n'))
}

export const outlineTool = defineDocTool({
  name: 'outline',
  description: 'List the sections of the current document: for each heading its id (s-12), number (4.2), level, line range (subsections included), word count and rev (changes when the section text changes), plus document totals and warnings (level jumps, more than one H1). Call it first on a long document, then read sections with read_section or find text with search_document. Ids stay valid while the document is edited; line numbers do not. `under` lists one section\'s subtree; `depth` limits the heading levels (default 3).',
  schema: OutlineArgs,
  handler: handleOutline
})

export const readSectionTool = defineDocTool({
  name: 'read_section',
  description: 'Read one section of the current document with 1-indexed line numbers, like view_document. Name it by id from outline ("s-12"), by number ("4.2") or by its exact heading text. Subsections are included unless include_subsections is false. A section longer than max_chars ends with a hint naming the offset_line to continue with.',
  schema: ReadSectionArgs,
  handler: handleReadSection
})

export const searchDocumentTool = defineDocTool({
  name: 'search_document',
  description: 'Find every occurrence of a word, phrase or pattern in the current document. Returns the total count, then one line per match: match id (m1, m2, ...), line number, section id and heading path, and the line around the match with the match marked «like this». Code, math, URLs and link targets are skipped by default and counted separately. Use it to locate passages in a long document and before a document-wide change. Examples: {"query": "Kunde"} finds Kunde, Kunden, Kundendienst; {"query": "kunde", "wholeWord": true} finds only the word Kunde in any case; {"query": "Kund(e|en|in|innen)\\\\b", "regex": true} finds the word forms and lists the ending as a group.',
  schema: SearchDocumentArgs,
  handler: handleSearchDocument
})
