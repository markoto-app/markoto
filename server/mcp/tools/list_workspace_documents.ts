import { z } from 'zod'
import { buildWorkspaceBoundTool } from '../lib/wrapDocBoundTool'
import { ListWorkspaceDocumentsArgs } from '../../utils/ai/tools/crossDocumentTools'

// MCP variant of the in-app `list_workspace_documents`. Workspace-bound:
// takes workspace_id explicitly (the loop derives it from the active doc);
// the stub context carries the membership proof the handler lists with.
export default buildWorkspaceBoundTool({
  name: 'list_workspace_documents',
  description: 'List one page of the documents in a workspace you are a member of, most recently edited first: id, title, folder path, last edited and a short description, plus total and next_cursor. Narrow to one folder with folder_id (from list_folders). To find a document by name or content, use search_documents.',
  scope: 'documents:read',
  minRole: 'viewer',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    workspace_id: z.string().min(1).describe('The workspace id to list.'),
    // The in-app tool's arguments, unchanged.
    ...ListWorkspaceDocumentsArgs.shape
  }
})
