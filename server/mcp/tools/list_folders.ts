import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'

// User-only with an optional workspace: without one the call lists the
// caller's personal folders (an MCP call has no current document). The
// handler proves the workspace role itself and answers "not found" alike
// for a missing workspace and one the caller is not a member of.
export default buildUserOnlyTool({
  name: 'list_folders',
  description: 'List the folders of a workspace you are a member of, or of your personal documents: folder_id, full path ("Projects / 2026"), parent_id and the number of documents filed directly in each.',
  scope: 'documents:read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    workspace_id: z.string().trim().min(1).max(64).optional().describe('The workspace id. Omit (or "personal") for your personal folders.')
  }
})
