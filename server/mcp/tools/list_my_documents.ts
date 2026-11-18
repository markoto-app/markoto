import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'
import { ListMyDocumentsArgs } from '../../utils/ai/tools/crossDocumentTools'

// User-only: one page of the caller's personal documents (owned, in no
// workspace). Same definition as the in-app loop's `list_my_documents`
// (`server/utils/ai/tools/crossDocumentTools.ts`).
export default buildUserOnlyTool({
  name: 'list_my_documents',
  description: 'List one page of your personal documents (owned by you, not in any workspace), most recently edited first: id, title, folder path, last edited and a short description, plus total and next_cursor. Workspace documents: list_workspace_documents or search_documents.',
  scope: 'documents:read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  // The in-app tool's arguments, unchanged.
  inputSchema: ListMyDocumentsArgs.shape
})
