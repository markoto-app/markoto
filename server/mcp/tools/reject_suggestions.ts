import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { toolEnabled } from '../lib/mcpToolContext'
import { resolveSuggestionsTool } from '../lib/suggestionTools'

// MCP-only (see lib/suggestionTools.ts): reject suggestions, as in the editor's suggestions panel.
export default defineMcpTool({
  name: 'reject_suggestions',
  title: 'Reject Suggestions',
  description: 'Reject suggestions: discard the proposed changes, the text stays as it is. Give suggestion_ids (from list_suggestions), or author_key for all of one author\'s, or neither for every open suggestion. Only people who edit the document directly may do this.',
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id.'),
    suggestion_ids: z.array(z.string().min(1).max(40)).min(1).max(500).optional().describe('Suggestions to reject.'),
    author_key: z.string().min(1).max(80).optional().describe('Reject all suggestions of this author (author_key from list_suggestions).')
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  enabled: event => toolEnabled(event, 'documents:write', 'reject_suggestions'),
  handler: async args => resolveSuggestionsTool('reject', String(args.doc_id ?? ''), {
    ...(args.suggestion_ids ? { ids: args.suggestion_ids } : {}),
    ...(args.author_key ? { authorKey: args.author_key } : {})
  })
})
