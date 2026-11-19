import { z } from 'zod'
import { buildDocSessionTool } from '../lib/wrapDocBoundTool'
import { suggestEdit } from '../lib/suggestionTools'

// MCP-only (see lib/suggestionTools.ts): propose a change as a suggestion.
export default buildDocSessionTool({
  name: 'suggest_edit',
  description: 'Propose replacing the one occurrence of old_str with new_str as a suggestion that a person accepts or rejects in the editor; the document text does not change until then. Matching works like replace_text. Use an empty new_str to suggest deleting the text.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id.'),
    old_str: z.string().min(1).describe('The text to change, copied from view_document without line-number prefixes. Must match exactly one location.'),
    new_str: z.string().describe('The proposed text. An empty string suggests deleting old_str.')
  },
  run: (session, args) => suggestEdit(session, args.old_str, args.new_str)
})
