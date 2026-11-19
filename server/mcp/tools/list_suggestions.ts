import { z } from 'zod'
import { buildDocSessionTool } from '../lib/wrapDocBoundTool'
import { listSuggestions } from '../lib/suggestionTools'

// MCP-only (see lib/suggestionTools.ts): the open suggestions of a document.
export default buildDocSessionTool({
  name: 'list_suggestions',
  description: 'List the open suggestions of a document (proposed changes not applied yet): id, kind (insert / delete / replace), author, the struck and the inserted text, and offsets in the current text. Accept or reject them with accept_suggestions / reject_suggestions.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id.')
  },
  run: async session => listSuggestions(session)
})
