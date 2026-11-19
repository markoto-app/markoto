import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { toolEnabled } from '../lib/mcpToolContext'
import { suggestEditTool } from '../lib/suggestionTools'

// MCP-only (see lib/suggestionTools.ts): propose a change as a suggestion.
export default defineMcpTool({
  name: 'suggest_edit',
  title: 'Suggest Edit',
  description: 'Propose replacing the one occurrence of old_str with new_str as a suggestion that a person accepts or rejects in the editor; the document text does not change until then. Matching works like replace_text. Use an empty new_str to suggest deleting the text.',
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id.'),
    old_str: z.string().min(1).describe('The text to change, copied from view_document without line-number prefixes. Must match exactly one location.'),
    new_str: z.string().describe('The proposed text. An empty string suggests deleting old_str.')
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  enabled: event => toolEnabled(event, 'documents:write', 'suggest_edit'),
  handler: async args => suggestEditTool(String(args.doc_id ?? ''), args.old_str, args.new_str)
})
