import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'
import { SearchDocumentsArgs } from '../../utils/ai/tools/crossDocumentTools'

// User-only: the optional `workspace_id` narrows the search instead of
// binding the call to one workspace, so the workspace builder doesn't fit.
// The handler runs the explorer's search (`searchEverywhere`), which proves
// each workspace membership itself (SSO included), exactly like
// GET /api/search/documents.
export default buildUserOnlyTool({
  name: 'search_documents',
  description: 'Full-text search over the titles and text of every document you can open: personal documents, every workspace you are a member of, and documents shared with you. Narrow with workspace_id ("personal" for personal documents) or folder_id (with its subfolders). Returns up to 20 best matches: id, title, workspace, folder path, last edited and a snippet with the matched words in **bold**.',
  scope: 'documents:read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  // The in-app tool's arguments, unchanged.
  inputSchema: SearchDocumentsArgs.shape
})
