import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { toolEnabled } from '../lib/mcpToolContext'
import { listSuggestionsTool } from '../lib/suggestionTools'

// MCP-only (see lib/suggestionTools.ts): the open suggestions of a document.
export default defineMcpTool({
  name: 'list_suggestions',
  title: 'List Suggestions',
  description: 'List the open suggestions of a document (proposed changes not applied yet): id, kind (insert / delete / replace), author, the struck and the inserted text, and offsets in the current text. Accept or reject them with accept_suggestions / reject_suggestions.',
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id.')
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  enabled: event => toolEnabled(event, 'documents:read', 'list_suggestions'),
  handler: async args => listSuggestionsTool(String(args.doc_id ?? ''))
})
