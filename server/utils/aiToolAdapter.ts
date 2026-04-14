// Translates text-editor tool commands to Y.Text operations on a Y.Doc shared
// via Hocuspocus. Edits appear live on every connected client.
//
// Two entry points:
//   - `executeEditorTool(session, input)` — legacy (Anthropic-shaped; takes
//     `{ command, ...args }`). Preserved for any future consumer.
//   - `executeFunctionByName(session, name, args)` — Gemini-shaped; takes a
//     function name and the args object, routes to the right handler.

import type { AiSession } from './aiClient'
import type {
  ViewDocumentInput,
  ReplaceTextInput,
  InsertTextInput
} from './agentic/functionTools'

// The AI only ever operates on a single logical "file".
export const DOCUMENT_PATH = 'document.md'

export interface ToolResult {
  content: string
  isError: boolean
}

function ok(content: string): ToolResult {
  return { content, isError: false }
}

function err(content: string): ToolResult {
  return { content, isError: true }
}

/**
 * Prepends 1-indexed line numbers to each line, matching Anthropic's docs.
 */
function withLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n')
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n')
}

function handleView(
  session: AiSession,
  input: { path: string; view_range?: [number, number]; max_characters?: number }
): ToolResult {
  if (input.path !== DOCUMENT_PATH) {
    return err(`Error: This agent can only access ${DOCUMENT_PATH}. Got: ${input.path}`)
  }

  const fullText = session.ytext.toString()
  const lines = fullText.split('\n')
  let startLine = 1
  let endLine = lines.length
  if (input.view_range) {
    const [start, end] = input.view_range
    if (start < 1) return err('Error: view_range start must be >= 1')
    startLine = start
    endLine = end === -1 ? lines.length : end
    if (endLine < startLine) return err('Error: view_range end must be >= start')
  }

  const slice = lines.slice(startLine - 1, endLine).join('\n')
  let output = withLineNumbers(slice, startLine)

  if (typeof input.max_characters === 'number' && output.length > input.max_characters) {
    output = output.slice(0, input.max_characters) + '\n[truncated]'
  }

  return ok(output)
}

function findIndexOfOnlyMatch(haystack: string, needle: string): { found: number; count: number } {
  if (needle.length === 0) return { found: -1, count: 0 }
  let count = 0
  let first = -1
  let i = 0
  while (true) {
    const pos = haystack.indexOf(needle, i)
    if (pos === -1) break
    if (count === 0) first = pos
    count += 1
    i = pos + needle.length
  }
  return { found: count === 1 ? first : -1, count }
}

function handleStrReplace(
  session: AiSession,
  input: { path: string; old_str: string; new_str: string }
): ToolResult {
  if (input.path !== DOCUMENT_PATH) {
    return err(`Error: This agent can only access ${DOCUMENT_PATH}. Got: ${input.path}`)
  }
  if (typeof input.old_str !== 'string' || typeof input.new_str !== 'string') {
    return err('Error: old_str and new_str are required')
  }
  if (input.old_str.length === 0) {
    return err('Error: old_str cannot be empty (use `insert` for empty insertion)')
  }

  const full = session.ytext.toString()
  const { found, count } = findIndexOfOnlyMatch(full, input.old_str)

  if (count === 0) {
    return err('Error: No match found for old_str. The string must match exactly, including whitespace.')
  }
  if (count > 1) {
    return err(`Error: Found ${count} matches for old_str. Please provide more surrounding context to make a unique match.`)
  }

  session.updateStatus('editing', 'Applying edit…')

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ytext.delete(found, input.old_str.length)
    session.ytext.insert(found, input.new_str)
  }, origin)

  return ok('Successfully replaced text at exactly one location.')
}

function handleInsert(
  session: AiSession,
  input: { path: string; insert_line: number; insert_text: string }
): ToolResult {
  if (input.path !== DOCUMENT_PATH) {
    return err(`Error: This agent can only access ${DOCUMENT_PATH}. Got: ${input.path}`)
  }
  if (typeof input.insert_line !== 'number' || input.insert_line < 0) {
    return err('Error: insert_line must be >= 0 (0 means beginning of file)')
  }
  if (typeof input.insert_text !== 'string') {
    return err('Error: insert_text is required')
  }

  const full = session.ytext.toString()
  const lines = full.split('\n')
  if (input.insert_line > lines.length) {
    return err(`Error: insert_line ${input.insert_line} is beyond the end of the file (${lines.length} lines)`)
  }

  // Compute char index for the start of line (insert_line + 1).
  // insert_line=0 → beginning of file (idx 0).
  // insert_line=N → after line N, i.e., at the start of line N+1.
  let idx = 0
  for (let i = 0; i < input.insert_line; i++) {
    // Bounds-checked above (insert_line <= lines.length); `!` tells TS.
    idx += lines[i]!.length + 1 // +1 for the newline
  }

  session.updateStatus('editing', 'Applying insert…')

  const origin = `ai:assistant:${session.sessionId}`
  // Ensure the insertion itself ends with a newline so it forms clean lines.
  const insertText = input.insert_text.endsWith('\n') ? input.insert_text : input.insert_text + '\n'
  session.ydoc.transact(() => {
    session.ytext.insert(idx, insertText)
  }, origin)

  return ok('Successfully inserted text.')
}

function handleCreate(): ToolResult {
  return err('Error: The document already exists and cannot be re-created. Use str_replace or insert to modify its contents.')
}

/**
 * Legacy Anthropic-shaped dispatcher. Kept for any future consumer that still
 * talks the `{ command, ...args }` shape; our Gemini loop calls
 * `executeFunctionByName` directly instead.
 */
export function executeEditorTool(session: AiSession, input: any): ToolResult {
  const command = input?.command
  switch (command) {
    case 'view':
      return handleView(session, input)
    case 'str_replace':
      return handleStrReplace(session, input)
    case 'insert':
      return handleInsert(session, input)
    case 'create':
      return handleCreate()
    default:
      return err(`Error: Unknown command "${command}". Supported: view, str_replace, insert.`)
  }
}

/**
 * Gemini-shaped dispatcher. Args are expected pre-validated by Zod (see
 * `server/utils/agentic/functionTools.ts`); callers must not pass unvalidated
 * input. Defensive casts that used to live here (`String(...)`, `Number(...)`)
 * are now handled upstream — if args fail the Zod schema, the loop emits a
 * `functionResponse.isError` and this function is never called.
 *
 * `web_search` is NOT routed here — the main loop handles it via the
 * `webSearch` sub-call helper in `functionTools.ts` because it needs the
 * `GoogleGenAI` client and is async.
 */
export function executeFunctionByName(
  session: AiSession,
  name: string,
  args: unknown
): ToolResult {
  switch (name) {
    case 'view_document':
      return handleView(session, {
        path: DOCUMENT_PATH,
        view_range: (args as ViewDocumentInput).view_range
      })
    case 'replace_text': {
      const a = args as ReplaceTextInput
      return handleStrReplace(session, {
        path: DOCUMENT_PATH,
        old_str: a.old_str,
        new_str: a.new_str
      })
    }
    case 'insert_text': {
      const a = args as InsertTextInput
      return handleInsert(session, {
        path: DOCUMENT_PATH,
        insert_line: a.insert_line,
        insert_text: a.insert_text
      })
    }
    default:
      return err(`Error: Unsupported function "${name}". Supported: view_document, replace_text, insert_text, web_search.`)
  }
}
