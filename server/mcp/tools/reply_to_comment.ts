import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

export default buildDocBoundTool({
  name: 'reply_to_comment',
  description: 'Add a reply to an existing comment thread. Use `read_comments` first to discover the comment_id.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id containing the thread.'),
    comment_id: z.string().min(1).max(64).describe('The id of the comment thread to reply to (from read_comments).'),
    body: z.string().trim().min(1).max(2000).describe('Reply body (max 2000 chars). May include @[Name](user:ID) mention tokens.')
  }
})
