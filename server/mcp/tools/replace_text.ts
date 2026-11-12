import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// Replace one unique exact-match string in a document. `old_str` must
// match exactly ONCE: zero or multiple matches both error. Pair with
// `view_document` to confirm uniqueness before calling.
export default buildDocBoundTool({
  name: 'replace_text',
  description: 'Replace a unique exact-match string in a document. Errors if old_str matches zero or multiple times.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id to edit.'),
    old_str: z.string().min(1).describe('The exact text to replace. Must match EXACTLY ONE location including whitespace, include enough surrounding context to be unique.'),
    new_str: z.string().describe('The replacement text. Use an empty string to delete the match.')
  }
})
