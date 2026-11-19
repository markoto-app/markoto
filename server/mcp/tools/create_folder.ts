import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'
import { CreateFolderArgs } from '../../utils/ai/tools/folderTools'

// User-only with an optional workspace (personal folders without one). The
// handler proves the editor role in the workspace (or the parent folder's
// scope) itself; plans without `mcpWrite` don't get the tool (class write).
export default buildUserOnlyTool({
  name: 'create_folder',
  description: 'Create a folder in a workspace (you need the editor or admin role) or in your personal documents, at the top level or inside parent_id. Returns the new folder_id and its path.',
  scope: 'documents:write',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    workspace_id: z.string().trim().min(1).max(64).optional().describe('The workspace id. Omit (or "personal") for your personal documents; with parent_id the parent\'s scope is used.'),
    name: CreateFolderArgs.shape.name,
    parent_id: CreateFolderArgs.shape.parent_id
  }
})
