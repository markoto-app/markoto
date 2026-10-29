import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

export default buildDocBoundTool({
  name: 'create_comment',
  description: 'Place a new comment anchored to a line range. Appears in real time in the doc\'s comment sidebar.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id to comment on.'),
    start_line: z.number().int().min(1).describe('First line of the anchored range (1-indexed, inclusive).'),
    end_line: z.number().int().min(1).describe('Last line of the anchored range (1-indexed, inclusive, >= start_line).'),
    body: z.string().trim().min(1).max(4000).describe('Comment body (max 4000 chars). Plain text — comments do not render Markdown. May include @[Name](user:ID) mention tokens.')
  }
})
