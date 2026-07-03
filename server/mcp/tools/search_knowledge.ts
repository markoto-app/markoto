import { z } from 'zod'
import { buildWorkspaceBoundTool } from '../lib/wrapDocBoundTool'

export default buildWorkspaceBoundTool({
  name: 'search_knowledge',
  description: 'Hybrid (vector + BM25) search over a workspace\'s uploaded knowledge files. Returns the top-K relevant chunks with source filename and semantic + lexical scores.',
  scope: 'knowledge:read',
  minRole: 'viewer',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    workspace_id: z.string().min(1).describe('The workspace id whose knowledge base to search.'),
    query: z.string().trim().min(1).max(500).describe('Natural-language query — semantic match, ask the way you would ask a colleague.'),
    top_k: z.number().int().min(1).max(15).optional().describe('How many chunks to return. Default 5.')
  }
})
