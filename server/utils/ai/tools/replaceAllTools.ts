import { aiStatus } from '~~/shared/ai/statusSteps'
import { z } from 'zod'
import { defineDocTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import { newlineCount } from './documentText'
import type { DocToolContext } from '../../agentic/toolContext'
import { NO_OP_EDIT_ERROR_PREFIX } from '../../agentic/editProgress'
import { sectionAtLine, sectionLabel, type DocumentStructure, type Section } from './sections/parse'
import { resolveSection, sectionView, type SectionView } from './sections/sectionIds'
import { classifyMarkdownCached } from './sections/markdownMask'
import { describeSkipped } from './sections/search'
import { withoutEmDashes } from '../dashFilter'
import { ungroundedCitationError } from '../citationGuard'
import { headingLevelChanges, missingLinkingS, planReplaceAll, textAfterChanges, wordAround, wordForms, type PlannedMatch, type WordFormCount } from './sections/replaceAll'
import { applyTextEdits, headingLinkEdits, linkNote, withoutOverlaps, type LinkRetarget, type TextEdit } from './sections/anchorLinks'
import { planRenumber } from './sections/renumber'
import { REPLACE_CONFIRMATION_FORMS_MAX, REPLACE_CONFIRMATION_MIN_CHANGES } from '~~/shared/ai/replaceConfirmation'
import { applyEdits, SectionRef, type Args } from './sectionEditShared'

// Document-wide pattern edits: replace_all (a word, phrase or regex
// everywhere, previewed first, whole-word forms for compounds, a user
// confirmation for large renames, never a heading level change unless
// asked) and renumber_headings (every numbered heading put in order after
// a swap or move). Each applies as ONE Y.js transaction with the session
// origin; links to renamed headings follow in the same transaction.

export const RenumberHeadingsArgs = z.object({
  preview: z.boolean().optional().describe('true: only list what would change. false (default): apply.')
}).describe('Renumber every numbered heading in document order.')

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
  preview: z.boolean().optional().describe('true (default): only report what would change, with match ids and the word forms. false: apply.'),
  forms: z.array(z.object({
    word: z.string().trim().min(1).max(120).describe('A whole word as the preview lists it ("Pikettdienstes").'),
    replacement: z.string().max(200).describe('What that whole word becomes ("Bereitschaftsdienstes").')
  })).min(1).max(200).optional()
    .describe('Replace whole words instead of the query: every word containing the query that is listed here becomes its replacement (any case, case preserved); unlisted words stay unchanged. Use it when the preview\'s word forms show that a plain stem replacement breaks compounds or endings (German linking "s": Pikettdienst → Bereitschaftsdienst, not Bereitschaftdienst).'),
  changeHeadingLevels: z.boolean().optional()
    .describe('Allow the replacement to change heading levels (# marks) or to add or remove headings. Only when the user asked for that; by default such a replacement is refused.'),
  matchIds: z.array(z.string().max(40)).min(1).max(2_000).optional()
    .describe('Apply only these matches, ids from the preview ("m3@1a2b3c4d"). Refused when the document changed since the preview.'),
  case: z.enum(['preserve', 'as_given']).optional()
    .describe('preserve (default): MYPRODUCT becomes upper case, myproduct lower case, a capitalised match a capitalised replacement; a match written like the query gets the replacement as given. as_given: always exactly the replacement.')
}).describe('Replace every occurrence of a text or pattern in the document, preview first.')

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

const FORMS_SHOWN = 15

function formLine(f: WordFormCount): string {
  return `${f.word} (${f.count}) → ${f.after}`
}

/**
 * The word forms of the changes when some match sits inside a longer word,
 * and a warning when a stem replacement lands in compounds without a
 * linking "s". Empty when every match is a whole word.
 */
function formsText(text: string, changes: readonly PlannedMatch[]): string {
  if (!changes.some(m => wordAround(text, m.start, m.end).word.length > m.before.length)) return ''
  const forms = wordForms(text, changes)
  const shown = forms.slice(0, FORMS_SHOWN).map(formLine).join('; ')
  const more = forms.length > FORMS_SHOWN ? `; ${forms.length - FORMS_SHOWN} more forms` : ''
  const parts = [`Word forms: ${shown}${more}.`]
  const linking = missingLinkingS(text, changes)
  if (linking.length > 0) {
    const n = linking.reduce((sum, f) => sum + f.count, 0)
    parts.push(`Check: ${n} match${n === 1 ? ' sits' : 'es sit'} inside compound words where the replacement probably needs a linking "s" (${linking.slice(0, 4).map(f => f.after).join(', ')}). Do not apply this; call again with forms listing each whole word and its correct replacement.`)
  }
  return parts.join('\n')
}

/** The refusal for a replacement that would change heading levels (or add / remove headings). */
function levelProblem(structure: DocumentStructure, afterText: string): string | null {
  const { changed, added, removed } = headingLevelChanges(structure, afterText)
  if (changed.length === 0 && added === 0 && removed === 0) return null
  if (added > 0 || removed > 0) {
    const what = added > 0 ? `turn ${added} line${added === 1 ? '' : 's'} into headings` : `remove ${removed} heading${removed === 1 ? '' : 's'}`
    return `Error: this replacement would ${what}; nothing was changed. Keep the # marks out of query and replacement, or pass changeHeadingLevels: true if the user asked for that.`
  }
  const list = changed.slice(0, 5).map(c => `line ${c.line} "${c.heading.slice(0, 60)}" ${'#'.repeat(c.from)} → ${'#'.repeat(c.to)}`).join('; ')
  return `Error: this replacement would change the level of ${changed.length} heading${changed.length === 1 ? '' : 's'} (${list}${changed.length > 5 ? '; ...' : ''}); nothing was changed. Keep each heading's # marks: capture them, e.g. query "^(#{1,6} )12\\b" with replacement "$110"; to put heading numbers in order call renumber_headings. Pass changeHeadingLevels: true only if the user asked to change heading levels.`
}

interface ReplaceAllContext {
  ctx: DocToolContext
  args: Args<typeof ReplaceAllArgs>
  view: SectionView
  matches: PlannedMatch[]
  changes: PlannedMatch[]
  unchanged: number
  links: LinkRetarget
  head: string
  notTouched: string
  unlisted: string
}

function previewReplaceAll(c: ReplaceAllContext): ToolResult {
  const { structure } = c.view
  const rows = c.changes.slice(0, PREVIEW_ROWS).map(m => diffRow(structure, c.view, m, structure.rev))
  const forms = formsText(structure.text, c.changes)
  const parts = [
    `Preview, nothing changed yet. ${c.head} ${c.changes.length} would change${c.unchanged > 0 ? `, ${c.unchanged} already read so` : ''}.${c.unlisted}${linkNote(c.links)}`,
    ...(forms ? [forms] : []),
    ...rows
  ]
  if (c.changes.length > PREVIEW_ROWS) parts.push(`(first ${PREVIEW_ROWS} of ${c.changes.length} shown; the rest are m-ids in document order, same rev)`)
  const confirm = c.changes.length >= REPLACE_CONFIRMATION_MIN_CHANGES && c.ctx.confirmReplace ? ' The user is shown the count and the word forms and confirms before anything changes.' : ''
  parts.push(`Apply all: the same call with preview false.${confirm} Apply some: add matchIds with the ids to replace. Wrong hits: tighten the query (wholeWord, caseSensitive, regex, scope) and preview again; wrong word forms: give forms.`)
  return toolOk(parts.join('\n'))
}

/** The user's go-ahead for a large replacement: null when allowed (or nobody can be asked), else the tool result. */
async function confirmLargeReplace(c: ReplaceAllContext): Promise<ToolResult | null> {
  const { ctx, changes } = c
  if (!ctx.confirmReplace || changes.length < REPLACE_CONFIRMATION_MIN_CHANGES) return null
  const forms = wordForms(c.view.structure.text, changes)
    .slice(0, REPLACE_CONFIRMATION_FORMS_MAX)
    .map(f => ({ from: f.word, to: f.after, count: f.count }))
  const answer = await ctx.confirmReplace({ total: changes.length, forms })
  if (answer.allowed) return null
  const note = answer.note ? ` The user added this instruction, follow it: ${JSON.stringify(answer.note)}` : ' Ask the user what to change instead, or stop.'
  return toolError(`The user did not apply the ${changes.length} replacements (or did not answer); nothing was changed.${note}`)
}

async function applyReplaceAll(c: ReplaceAllContext): Promise<ToolResult> {
  const { ctx, args, changes } = c
  if (changes.length === 0) {
    return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: every selected match already reads like its replacement. Do not repeat this call.`)
  }
  const refused = await confirmLargeReplace(c)
  if (refused) return refused
  // The document may have changed while the user was deciding.
  if (sectionView(ctx).structure.rev !== c.view.structure.rev) {
    return toolError('Error: the document changed while the user was confirming; nothing was replaced. Preview again.')
  }
  ctx.updateStatus('editing', aiStatus('editDocument'))
  applyEdits(ctx, [
    ...changes.map(m => ({ start: m.start, end: m.end, text: m.after })),
    ...c.links.edits
  ])
  const lines = [...new Set(changes.map(m => m.line))]
  const lineList = `${lines.slice(0, 20).join(', ')}${lines.length > 20 ? ', ...' : ''}`
  const shift = changes.reduce((n, m) => n + newlineCount(m.after) - newlineCount(m.before), 0)
  const shiftText = shift === 0 ? '' : ` Line numbers after line ${lines[0]} shifted; read again before line-based edits.`
  const plural = changes.length === 1 ? '' : 's'
  return {
    ...toolOk(`Replaced ${changes.length} occurrence${plural} of "${args.query}" in one edit (lines ${lineList}); doc rev now ${sectionView(ctx).structure.rev}.${c.notTouched}${c.unlisted}${linkNote(c.links)}${shiftText}`),
    activity: { kind: 'ai.tool', tool: 'replace_all', query: args.query.slice(0, 200), replacement: args.replacement.slice(0, 200), count: changes.length }
  }
}

function scopeView(ctx: DocToolContext, scope: string | undefined): { ok: true, view: SectionView, section: Section | null, id: string } | { ok: false, error: string } {
  const ref = scope?.trim()
  if (!ref || ref.toLowerCase() === 'all') return { ok: true, view: sectionView(ctx), section: null, id: '' }
  return resolveSection(ctx, ref)
}

/** The AI-written replacement texts without em-dashes (unless code is included: a code match keeps what was asked for). */
function filteredReplaceArgs(given: Args<typeof ReplaceAllArgs>): Args<typeof ReplaceAllArgs> {
  if (given.excludeCode === false) return given
  return {
    ...given,
    replacement: withoutEmDashes(given.replacement),
    ...(given.forms ? { forms: given.forms.map(f => ({ ...f, replacement: withoutEmDashes(f.replacement) })) } : {})
  }
}

function unlistedText(unlisted: ReadonlyArray<{ word: string, count: number }>): string {
  if (unlisted.length === 0) return ''
  return ` Not in forms, left unchanged: ${unlisted.slice(0, 10).map(u => `${u.word} (${u.count})`).join(', ')}${unlisted.length > 10 ? ', ...' : ''}.`
}

/** The selected matches that change, the text after them, and the refusal when they would change heading levels. */
function plannedChanges(structure: DocumentStructure, args: Args<typeof ReplaceAllArgs>, selected: readonly PlannedMatch[]): { changes: PlannedMatch[], afterText: string } | ToolResult {
  const changes = selected.filter(m => m.before !== m.after)
  const afterText = textAfterChanges(structure.text, changes)
  const problem = args.changeHeadingLevels ? null : levelProblem(structure, afterText)
  return problem ? toolError(problem) : { changes, afterText }
}

async function handleReplaceAll(ctx: DocToolContext, given: Args<typeof ReplaceAllArgs>): Promise<ToolResult> {
  const args = filteredReplaceArgs(given)
  const r = scopeView(ctx, args.scope)
  if (!r.ok) return toolError(r.error)
  const { view, section: scope } = r
  const { structure } = view
  const planned = planReplaceAll(structure, classifyMarkdownCached(structure.text), args, scope ? { startLine: scope.startLine, endLine: scope.endLine } : {})
  if (!planned.ok) return toolError(planned.error)
  const { matches, skipped, truncated, unlisted } = planned.plan
  const where = scope ? `section ${r.id} "${sectionLabel(scope)}"` : 'the whole document'
  const skippedText = describeSkipped(skipped)
  const notTouched = skippedText ? ` Not touched: ${skippedText}.` : ''
  if (truncated) return toolError(`Error: more than ${matches.length} matches for "${args.query}"; narrow the query or the scope.`)
  if (matches.length === 0) {
    const tip = args.wholeWord || args.caseSensitive ? ' Try without wholeWord / caseSensitive, or a regex for word forms.' : ''
    return toolOk(`No match for "${args.query}" (${flagsText(args)}) in ${where}; doc rev ${structure.rev}.${notTouched}${unlistedText(unlisted)}${tip}`)
  }
  const selected = args.matchIds ? selectMatches(args.matchIds, matches, structure.rev) : matches
  if (typeof selected === 'string') return toolError(selected)
  const next = plannedChanges(structure, args, selected)
  if ('content' in next) return next
  const { changes, afterText } = next
  const ungrounded = ungroundedCitationError(changes.map(m => m.after).join('\n'), changes.map(m => m.before).join('\n'), ctx.ydoc)
  if (ungrounded) return toolError(ungrounded)
  const links = headingLinkEdits(structure, afterText)
  const c: ReplaceAllContext = {
    ctx,
    args,
    view,
    matches,
    changes,
    unchanged: selected.length - changes.length,
    links: { ...links, edits: withoutOverlaps(links.edits, changes) },
    head: `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${args.query}" (${flagsText(args)}) in ${where}; doc rev ${structure.rev}.${notTouched}`,
    notTouched,
    unlisted: unlistedText(unlisted)
  }
  return (args.preview ?? true) ? previewReplaceAll(c) : applyReplaceAll(c)
}

// renumber_headings

function mismatchNote(mismatched: ReadonlyArray<{ line: number, heading: string }>): string {
  if (mismatched.length === 0) return ''
  const list = mismatched.slice(0, 5).map(m => `line ${m.line} "${m.heading.slice(0, 60)}"`).join(', ')
  return ` Left alone (their number's depth does not match their level): ${list}${mismatched.length > 5 ? ', ...' : ''}.`
}

function handleRenumberHeadings(ctx: DocToolContext, args: Args<typeof RenumberHeadingsArgs>): ToolResult {
  const { structure } = sectionView(ctx)
  const planned = planRenumber(structure)
  if (!planned.ok) return toolError(planned.error)
  const { changes, numbered, mismatched } = planned.plan
  const odd = mismatchNote(mismatched)
  if (changes.length === 0) {
    return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: all ${numbered} numbered headings are already in order.${odd} Do not repeat this call.`)
  }
  const numberEdits: TextEdit[] = changes.map(c => ({ start: c.start, end: c.end, text: c.to }))
  const numberChanges = new Map(changes.map(c => [c.section, { from: c.from, to: c.to }]))
  const links = headingLinkEdits(structure, applyTextEdits(structure.text, numberEdits), numberChanges)
  const list = changes.slice(0, 40).map(c => `line ${c.line} ${'#'.repeat(c.level)} ${c.from} → ${c.to} ${c.rest.slice(0, 50)}`)
  if (changes.length > 40) list.push(`(${changes.length - 40} more)`)
  if (args.preview) {
    return toolOk([`Preview, nothing changed yet: ${changes.length} of ${numbered} numbered headings would get a new number; levels and titles stay.${odd}${linkNote(links)}`, ...list, 'Apply: the same call with preview false.'].join('\n'))
  }
  ctx.updateStatus('editing', aiStatus('editDocument'))
  applyEdits(ctx, [...numberEdits, ...withoutOverlaps(links.edits, numberEdits)])
  return toolOk([
    `Renumbered ${changes.length} of ${numbered} numbered headings in one edit; levels and titles unchanged; doc rev now ${sectionView(ctx).structure.rev}.${odd}${linkNote(links)}`,
    ...list,
    'References in running text ("siehe Kapitel 12") are not changed; search_document for them if the numbers matter there.'
  ].join('\n'))
}

// Definitions

export const renumberHeadingsTool = defineDocTool({
  name: 'renumber_headings',
  description: 'Renumber every numbered heading of the document in order (1, 1.1, 1.1.1, ...) in one edit, for example after swap_sections or move_section: only the number in front of each heading changes; levels, titles and {#id} blocks stay, and links to the headings follow. Returns old → new per heading. Use it instead of replace_all or many set_heading calls whenever heading numbers must be put in order.',
  schema: RenumberHeadingsArgs,
  handler: handleRenumberHeadings
})

export const replaceAllTool = defineDocTool({
  name: 'replace_all',
  description: 'Replace every occurrence of a word, phrase or pattern in the document in one edit. First call previews (preview defaults to true): total count, skipped counts (code, math, URLs, link targets are left alone by default), the first diffs and match ids; then call again with preview false, optionally with matchIds to apply only some. Case is preserved by default (MYPRODUCT → MYNEWNAME). The preview lists the whole word forms the matches sit in; when a stem lands in compounds or endings (German Pikett → Bereitschaft: Pikettdienst must become Bereitschaftsdienst), apply with forms instead. Heading levels never change unless changeHeadingLevels is set; links to renamed headings follow them. A large replacement is shown to the user to confirm. To put heading numbers in order use renumber_headings, not replace_all. Use it for a deterministic change (rename a product, fix a recurring typo, change a URL); for one spot use replace_text; when the change needs grammar or judgement (German "Kunde" → "Klient" with articles and endings), use delegate_rewrite in terminology mode or per-occurrence edits.',
  schema: ReplaceAllArgs,
  handler: handleReplaceAll
})
