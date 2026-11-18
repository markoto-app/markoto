import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'
import { MoveDocumentArgs } from '../../utils/ai/tools/folderTools'

// User-only rather than doc-bound: filing a document changes a row, not the
// Y.js state, so no document connection is opened. The handler runs the
// explorer's `moveDocsToFolder`, which proves edit rights on the document
// and answers the same "not found" for a missing document and one the
// caller may not edit.
export default buildUserOnlyTool({
  name: 'move_document',
  description: 'File a document into a folder of its own workspace (or of your personal documents, for a personal document), or back to the top level with folder_id null. Needs edit rights on the document. Does not move documents between workspaces.',
  scope: 'documents:write',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  // The in-app tool's arguments, unchanged.
  inputSchema: MoveDocumentArgs.shape
})
