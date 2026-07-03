import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'

// User-only — lists docs the caller owns across every workspace they
// participate in. The handler `handleListMyDocuments` lives in
// `aiToolAdapter.ts` alongside its sibling `handleListWorkspaceDocuments`,
// is registered in `META_TOOL_HANDLERS`, and is also exposed to the
// in-app agentic loop via `ALL_TOOL_DECLARATIONS` — same code path
// for both consumers.
export default buildUserOnlyTool({
  name: 'list_my_documents',
  description: 'List recent documents owned by the authenticated user, across all workspaces. Returns id, title, description, language, access mode, workspace_id, word_count, and last-active timestamp.',
  scope: 'documents:read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(100).optional().describe('Max documents to return. Default 25, cap 100.')
  }
})
