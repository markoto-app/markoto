import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

export default buildDocBoundTool({
  name: 'read_comments',
  description: 'Read all comment threads on a document: ids, anchored line ranges, resolved status, bodies, and replies.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id whose comments to read.')
  }
})
