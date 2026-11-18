import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// Replace one unique string in a document. `old_str` must match exactly
// ONCE: zero or multiple matches both error (a miss shows the closest
// lines). Typographic differences (quotes, dashes, non-breaking spaces)
// and trailing whitespace are tolerated, as in the in-app tool.
export default buildDocBoundTool({
  name: 'replace_text',
  description: 'Replace the one occurrence of old_str with new_str in a document. Differences in quotes, dashes, non-breaking spaces and trailing whitespace are tolerated. Errors if old_str matches zero times (the error shows the closest lines) or several times.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id to edit.'),
    old_str: z.string().min(1).describe('The text to replace, copied from view_document without the line-number prefixes. Must match exactly one location; include enough surrounding context to be unique.'),
    new_str: z.string().describe('The replacement text. Use an empty string to delete the match.')
  }
})
