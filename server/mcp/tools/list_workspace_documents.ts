import { z } from 'zod'
import { buildWorkspaceBoundTool } from '../lib/wrapDocBoundTool'

// MCP variant of the in-app `list_workspace_documents`. Workspace-bound:
// takes workspace_id explicitly (vs deriving it from the active doc as
// the loop does). The handler reads `session.workspaceId` so the stub
// context built by the wrapper passes through the workspace id.
export default buildWorkspaceBoundTool({
  name: 'list_workspace_documents',
  description: 'List documents inside a workspace the caller is a member of.',
  scope: 'documents:read',
  minRole: 'viewer',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    workspace_id: z.string().min(1).describe('The workspace id to enumerate.')
  }
})
