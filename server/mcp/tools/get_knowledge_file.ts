import { z } from 'zod'
import { buildWorkspaceBoundTool } from '../lib/wrapDocBoundTool'

export default buildWorkspaceBoundTool({
  name: 'get_knowledge_file',
  description: 'Retrieve the full parsed markdown of a single knowledge file in a workspace. Truncated above ~40k chars with an explicit marker.',
  scope: 'knowledge:read',
  minRole: 'viewer',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    workspace_id: z.string().min(1).describe('The workspace id whose knowledge base to read from.'),
    knowledge_id: z.string().trim().min(1).max(64).describe('The knowledge id of the file to retrieve. Use search_knowledge or the workspace knowledge listing to discover ids.')
  }
})
