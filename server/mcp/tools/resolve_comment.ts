import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

export default buildDocBoundTool({
  name: 'resolve_comment',
  description: 'Resolve or reopen a comment thread. Resolved threads are hidden by default in the UI but not deleted.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id containing the thread.'),
    comment_id: z.string().min(1).max(64).describe('The id of the comment thread to resolve/reopen.'),
    resolved: z.boolean().describe('true to mark resolved, false to reopen.')
  }
})
