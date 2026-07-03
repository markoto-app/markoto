import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// `destructiveHint: true` — clients (Claude Desktop) may prompt the
// user for confirmation before invoking. The handler itself does its
// own authz: deleting requires either authorship (the comment was
// posted by this user / by AI Assistant) OR doc-management rights.
export default buildDocBoundTool({
  name: 'delete_comment',
  description: 'Delete a comment thread or a single reply within a thread. Can only delete entries you authored (or AI-authored entries) unless you have document management rights.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id containing the thread.'),
    comment_id: z.string().min(1).max(64).describe('The id of the comment thread.'),
    reply_id: z.string().min(1).max(64).optional().describe('If provided, delete only this specific reply. If omitted, delete the whole thread.')
  }
})
