import { aiStatus } from '~~/shared/ai/statusSteps'
import { z } from 'zod'
import { defineDocTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import { blockSpacedInsertText, boundedDocumentView, describeEditedRegion, lineShiftNote, lineToCharOffset, newlineCount } from './documentText'
import { closestLineRange, findEditTarget, firstOccurrenceLine, formatClosestLines, lineOfOffset, type MatchTier } from './textMatch'
import { TOOL_RESULT_CHAR_CAP } from '../../agentic/limits'
import { writeAccessOf, type DocToolContext } from '../../agentic/toolContext'
import { NO_OP_EDIT_ERROR_PREFIX } from '../../agentic/editProgress'
import { updateDocMeta } from '../../../repos/documents'
import * as Sentry from '@sentry/nuxt'
import { useLogger } from '../../platform/logger'
import { filterEmDashesAt } from '../dashFilter'
import { editText, SETTINGS_NOT_SUGGESTIBLE, suggestedNote } from './textWrite'

// Reading and editing the current document: view_document, replace_text,
// insert_text, set_title. Edits are Y.js transactions tagged with the AI
// session as origin, so they reach every connected client live.

const log = useLogger('ai-tools')

// NOTE on `view_range`: semantically a [start, end] tuple, but Zod's
// `z.tuple(...)` emits JSON Schema in draft-7 tuple form (`items: [...]`) or
// 2020-12 (`prefixItems: [...]`), which some providers' function-declaration
// validators reject ("schema at properties.view_range.items must be a boolean
// or an object"). A length-bounded array of integers flattens to the
// single-schema `items` shape. The [start, end] ordering is enforced by the
// description + the runtime bounds check in `handleView`.
const ViewDocumentArgs = z.object({
  view_range: z.array(z.number().int()).min(2).max(2)
    // Enforce at the schema level so the model self-corrects with a clean
    // error instead of hitting the runtime check in `handleView` (which
    // produces a less model-friendly message and burns a loop turn).
    .refine(([start, end]) => start !== undefined && end !== undefined && start >= 1 && (end === -1 || end >= start), {
      message: 'view_range must be [start, end] where start >= 1 and end is either -1 (read to EOF) or >= start'
    })
    .describe('Inclusive [startLine, endLine], both 1-indexed positive integers. Use -1 ONLY as the endLine sentinel (read to end of file). Never use -1 as start, start must be >= 1.')
    .optional()
}).describe('Read the current document with 1-indexed line numbers.')

const ReplaceTextArgs = z.object({
  old_str: z.string().min(1)
    .describe('The text to replace, copied from view_document without the line-number prefixes. Must match exactly one location; include enough surrounding text to be unique.'),
  new_str: z.string()
    .describe('The replacement text. Use an empty string to delete the match.')
}).describe('Replace the one location of old_str in the document with new_str.')

const InsertTextArgs = z.object({
  insert_line: z.number().int().min(0)
    .describe('Line number after which to insert. 0 = start of file.'),
  insert_text: z.string()
    .describe('Text to insert. A trailing newline is added automatically if not present.')
}).describe('Insert text after a specific line (1-indexed; 0 = start of file).')

const SetTitleArgs = z.object({
  // `.trim()` must come BEFORE `.min(1)` in Zod 4 for the length check
  // to see the trimmed string, otherwise "   " passes min(1) and only
  // later collapses to "" when the transform runs.
  title: z.string().trim().min(1).max(255)
    .describe('The new document title (1–255 characters after trimming leading/trailing whitespace).')
}).describe('Set the document title shown in the tab, topbar, and document listings.')

/**
 * Room a view_document result gets: below the loop's result cap
 * (`TOOL_RESULT_CHAR_CAP`), so the tool's own continuation hint is what the
 * model reads, not the loop's generic cut.
 */
const VIEW_DOCUMENT_CHAR_BUDGET = TOOL_RESULT_CHAR_CAP - 2_000

/** Added to a too-long view_document result: the section tools read a long document with less noise. */
const LONG_DOCUMENT_HINT = 'Better for a long document: outline (section ids, numbers and sizes), read_section and search_document.'

function handleView(
  session: DocToolContext,
  input: { view_range?: [number, number] }
): ToolResult {
  const fullText = session.ytext.toJSON()
  if (input.view_range) {
    const [start, end] = input.view_range
    if (start < 1) return toolError('Error: view_range start must be >= 1')
    if (end !== -1 && end < start) return toolError('Error: view_range end must be >= start')
  }
  return toolOk(boundedDocumentView(fullText, input.view_range, VIEW_DOCUMENT_CHAR_BUDGET, 'view_document', LONG_DOCUMENT_HINT))
}

const MIN_APPLIED_CHECK_CHARS = 4

/** The error for an `old_str` that matches nowhere, with what the model needs to fix the call. */
function noMatchError(full: string, input: { old_str: string, new_str: string }): ToolResult {
  const base = 'Error: No match found for old_str, even ignoring differences in quotes, dashes, spaces and trailing whitespace. The document context and conversation history are not part of the document and cannot be edited.'
  // A very short new_str ("x", "a") occurs anywhere and proves nothing.
  const appliedAt = input.new_str.trim().length >= MIN_APPLIED_CHECK_CHARS ? firstOccurrenceLine(full, input.new_str) : null
  if (appliedAt !== null) {
    return toolError(`${base} new_str is already in the document (line ${appliedAt}), so this edit may already be applied. Check with view_document and view_range [${appliedAt}, ${appliedAt + newlineCount(input.new_str)}] before editing again.`)
  }
  const range = closestLineRange(full, input.old_str)
  if (!range) {
    return toolError(`${base} Read the passage with view_document and view_range, then copy old_str from it exactly.`)
  }
  return toolError(`${base} The closest lines in the document:\n${formatClosestLines(full, range)}\nIf this is the passage you meant, copy old_str from these lines exactly.`)
}

const TIER_NOTE: Record<MatchTier, string> = {
  'exact': '',
  'typographic': ' old_str matched after normalising quotes, dashes and spaces; the document\'s own characters were replaced.',
  'trailing-whitespace': ' old_str matched after normalising quotes, dashes, spaces and trailing whitespace; the document\'s own characters were replaced.'
}

function handleStrReplace(
  session: DocToolContext,
  args: { old_str: string, new_str: string }
): ToolResult {
  const input = { old_str: args.old_str, new_str: args.new_str }
  if (input.old_str.length === 0) {
    return toolError('Error: old_str cannot be empty (use `insert_text` for empty insertion)')
  }

  const full = session.ytext.toJSON()
  const match = findEditTarget(full, input.old_str)

  if (match.kind === 'none') return noMatchError(full, input)
  if (match.kind === 'multiple') {
    const loose = match.tier === 'exact' ? '' : ' (after normalising quotes, dashes and spaces)'
    const more = match.count > match.lines.length ? ', ...' : ''
    return toolError(`Error: Found ${match.count} matches for old_str${loose}, at lines ${match.lines.join(', ')}${more}. Add surrounding text (a neighbouring sentence or line) so old_str matches exactly one location.`)
  }
  const matched = full.slice(match.start, match.end)
  input.new_str = filterEmDashesAt(full, match.start, input.new_str)
  // A replacement with itself changes nothing. Reporting it as a
  // success let the model "fix" the same passage over and over.
  if (input.old_str === input.new_str || matched === input.new_str) {
    return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: new_str is identical to old_str, so the document already reads this way. Do not repeat this call. If the request is done, finish without calling another tool.`)
  }

  session.updateStatus('editing', aiStatus('applyEdit'))

  const origin = `ai:assistant:${session.sessionId}`
  const written = editText(session, origin, (t) => {
    t.delete(match.start, matched.length)
    t.insert(match.start, input.new_str)
  })
  if (written.suggested !== null) return toolOk(suggestedNote(written.suggested))

  // The last line the match touched (a match ending in a newline ends on the line before).
  const lastOldLine = lineOfOffset(full, match.start) + newlineCount(matched) - (matched.endsWith('\n') ? 1 : 0)
  const shift = match.end < full.length ? lineShiftNote(lastOldLine, newlineCount(input.new_str) - newlineCount(matched)) : null
  const region = describeEditedRegion(session.ytext.toJSON(), match.start, input.new_str.length)
  return toolOk(`Replaced text at exactly one location.${TIER_NOTE[match.tier]} ${region}${shift ? `\n${shift}` : ''}`)
}

function handleInsert(
  session: DocToolContext,
  input: { insert_line: number, insert_text: string }
): ToolResult {
  const full = session.ytext.toJSON()
  const idx = lineToCharOffset(full, input.insert_line)
  if (idx === null) {
    const lineCount = full.split('\n').length
    return toolError(`Error: insert_line ${input.insert_line} is beyond the end of the file (${lineCount} lines)`)
  }

  session.updateStatus('editing', aiStatus('applyInsert'))

  const origin = `ai:assistant:${session.sessionId}`
  // Newline-terminated, with the blank lines a Markdown block needs around it.
  const insertText = blockSpacedInsertText(full, idx, filterEmDashesAt(full, idx, input.insert_text))
  const written = editText(session, origin, t => t.insert(idx, insertText))
  if (written.suggested !== null) return toolOk(suggestedNote(written.suggested))

  // Lines after the insertion point move down; at the end there are none.
  const shift = idx < full.length ? lineShiftNote(input.insert_line, newlineCount(insertText)) : null
  return toolOk(`Inserted text after line ${input.insert_line}. ${describeEditedRegion(session.ytext.toJSON(), idx, insertText.length)}${shift ? `\n${shift}` : ''}`)
}

async function handleSetTitle(
  session: DocToolContext,
  input: z.output<typeof SetTitleArgs>
): Promise<ToolResult> {
  // Zod trims and enforces 1–255; belt-and-braces re-check so an empty
  // trim result never reaches ymeta/DB (the meta.put endpoint also
  // validates server-side, but AI bypasses that route).
  const title = input.title.trim()
  if (session.suggestSink) return toolError(SETTINGS_NOT_SUGGESTIBLE)
  if (title.length === 0) return toolError('Error: title cannot be empty')
  if (title.length > 255) return toolError('Error: title too long (max 255 chars)')

  session.updateStatus('editing', aiStatus('setTitleAny'))

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ymeta.set('title', title)
  }, origin)

  try {
    await updateDocMeta(writeAccessOf(session), { title })
  } catch (e) {
    // Same tradeoff as theme: Y.js already broadcast the change live;
    // DB failure only affects what brand-new visitors see before sync.
    log.warn('title DB persist failed', { docId: session.docId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'title_persist_failed', docId: session.docId }
    })
  }

  return toolOk(`Title set to "${title}".`)
}

export const viewDocumentTool = defineDocTool({
  name: 'view_document',
  description: 'Read the current document with 1-indexed line numbers prepended to each line. Always read before editing so you have current content to match against. Use it for short documents and for exact line ranges; for a long document start with outline and read sections with read_section, and find words with search_document. Without view_range a short document is returned in full; a long one returns a heading outline with each section\'s line range plus the first lines. A result that hits the size limit says which view_range continues it.',
  schema: ViewDocumentArgs,
  handler: (ctx, args) => {
    // The schema keeps `view_range` an array of exactly two (a tuple schema
    // is refused by some providers' validators).
    const [start, end] = args.view_range ?? []
    return handleView(ctx, {
      view_range: start !== undefined && end !== undefined ? [start, end] : undefined
    })
  }
})

export const replaceTextTool = defineDocTool({
  name: 'replace_text',
  description: 'Replace the one occurrence of `old_str` with `new_str` in the document. `old_str` must match exactly one location; include enough surrounding text to be unique. Differences in quotes, dashes, non-breaking spaces and trailing whitespace are tolerated. Errors on zero or several matches (a miss shows the closest lines) or when `new_str` equals `old_str`. On success the result shows the edited lines as they now read and says when line numbers below the edit shifted.',
  schema: ReplaceTextArgs,
  handler: handleStrReplace
})

export const insertTextTool = defineDocTool({
  name: 'insert_text',
  description: 'Insert `insert_text` after line `insert_line` (1-indexed). Use insert_line=0 to insert at the very start of the document. The inserted text is newline-terminated automatically, and a blank line is added where a new block (heading, paragraph, list, image) meets other content. Never call this just to add empty lines. The result shows the inserted lines as they now read.',
  schema: InsertTextArgs,
  handler: handleInsert
})

export const setTitleTool = defineDocTool({
  name: 'set_title',
  description: 'Set the document title (1–255 chars). The title appears in the browser tab, topbar, and document listings, and is usable in header/footer templates via the {title} token. Use when the user asks to rename the document, or to give an untitled doc a title based on its contents.',
  schema: SetTitleArgs,
  handler: handleSetTitle
})
