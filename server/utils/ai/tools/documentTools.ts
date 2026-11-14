import { aiStatus } from '~~/shared/ai/statusSteps'
import { z } from 'zod'
import { defineDocTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import { describeEditedRegion, findIndexOfOnlyMatch, lineToCharOffset, withLineNumbers } from './documentText'
import { writeAccessOf, type DocToolContext } from '../../agentic/toolContext'
import { NO_OP_EDIT_ERROR_PREFIX } from '../../agentic/editProgress'
import { updateDocMeta } from '../../../repos/documents'
import * as Sentry from '@sentry/nuxt'
import { useLogger } from '../../platform/logger'

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
    .describe('The exact text to replace. Must match EXACTLY ONE location including whitespace, include enough surrounding context to be unique.'),
  new_str: z.string()
    .describe('The replacement text. Use an empty string to delete the match.')
}).describe('Replace a unique exact-match string in the document.')

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

function handleView(
  session: DocToolContext,
  input: { view_range?: [number, number], max_characters?: number }
): ToolResult {
  const fullText = session.ytext.toJSON()
  const lines = fullText.split('\n')
  let startLine = 1
  let endLine = lines.length
  if (input.view_range) {
    const [start, end] = input.view_range
    if (start < 1) return toolError('Error: view_range start must be >= 1')
    startLine = start
    endLine = end === -1 ? lines.length : end
    if (endLine < startLine) return toolError('Error: view_range end must be >= start')
  }

  const slice = lines.slice(startLine - 1, endLine).join('\n')
  let output = withLineNumbers(slice, startLine)

  if (typeof input.max_characters === 'number' && output.length > input.max_characters) {
    output = output.slice(0, input.max_characters) + '\n[truncated]'
  }

  return toolOk(output)
}

function handleStrReplace(
  session: DocToolContext,
  input: { old_str: string, new_str: string }
): ToolResult {
  if (input.old_str.length === 0) {
    return toolError('Error: old_str cannot be empty (use `insert_text` for empty insertion)')
  }

  const full = session.ytext.toJSON()
  const { found, count } = findIndexOfOnlyMatch(full, input.old_str)

  if (count === 0) {
    return toolError('Error: No match found for old_str. The string must match the document text exactly, including whitespace, call view_document to see it. The document context and conversation history are not part of the document and cannot be edited.')
  }
  if (count > 1) {
    return toolError(`Error: Found ${count} matches for old_str. Please provide more surrounding context to make a unique match.`)
  }
  // A replacement with itself changes nothing. Reporting it as a
  // success let the model "fix" the same passage over and over.
  if (input.old_str === input.new_str) {
    return toolError(`${NO_OP_EDIT_ERROR_PREFIX}: new_str is identical to old_str, so the document already reads this way. Do not repeat this call. If the request is done, finish without calling another tool.`)
  }

  session.updateStatus('editing', aiStatus('applyEdit'))

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ytext.delete(found, input.old_str.length)
    session.ytext.insert(found, input.new_str)
  }, origin)

  return toolOk(`Replaced text at exactly one location. ${describeEditedRegion(session.ytext.toJSON(), found, input.new_str.length)}`)
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
  // Ensure the insertion itself ends with a newline so it forms clean lines.
  const insertText = input.insert_text.endsWith('\n') ? input.insert_text : input.insert_text + '\n'
  session.ydoc.transact(() => {
    session.ytext.insert(idx, insertText)
  }, origin)

  return toolOk(`Inserted text after line ${input.insert_line}. ${describeEditedRegion(session.ytext.toJSON(), idx, insertText.length)}`)
}

async function handleSetTitle(
  session: DocToolContext,
  input: z.output<typeof SetTitleArgs>
): Promise<ToolResult> {
  // Zod trims and enforces 1–255; belt-and-braces re-check so an empty
  // trim result never reaches ymeta/DB (the meta.put endpoint also
  // validates server-side, but AI bypasses that route).
  const title = input.title.trim()
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
  description: 'Read the current document with 1-indexed line numbers prepended to each line. Always call this before making any edits so you have current content to match against. Returns the full text unless a view_range is specified.',
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
  description: 'Replace a single exact-match occurrence of `old_str` with `new_str` in the document. `old_str` must match EXACTLY ONE location including whitespace, include enough surrounding context to be unique. Returns an error if zero or multiple matches are found, or if `new_str` equals `old_str`. On success the result shows the edited lines as they now read.',
  schema: ReplaceTextArgs,
  handler: handleStrReplace
})

export const insertTextTool = defineDocTool({
  name: 'insert_text',
  description: 'Insert `insert_text` after line `insert_line` (1-indexed). Use insert_line=0 to insert at the very start of the document. The inserted text is newline-terminated automatically. Put any blank line you need INSIDE `insert_text` (e.g. "\\nNew paragraph."), never call this just to add empty lines. The result shows the inserted lines as they now read.',
  schema: InsertTextArgs,
  handler: handleInsert
})

export const setTitleTool = defineDocTool({
  name: 'set_title',
  description: 'Set the document title (1–255 chars). The title appears in the browser tab, topbar, and document listings, and is usable in header/footer templates via the {title} token. Use when the user asks to rename the document, or to give an untitled doc a title based on its contents.',
  schema: SetTitleArgs,
  handler: handleSetTitle
})
