import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// MCP-side `view_document`. Same body as the in-app loop tool — read
// the doc with 1-indexed line prefixes — gated on `documents:read`
// and the user's view access to the requested doc_id.
export default buildDocBoundTool({
  name: 'view_document',
  description: 'Read a document with 1-indexed line numbers prefixed on each line. Optional view_range to fetch a slice.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to read.'),
    view_range: z.array(z.number().int()).min(2).max(2)
      .refine(([start, end]) => start !== undefined && end !== undefined && start >= 1 && (end === -1 || end >= start), {
        message: 'view_range must be [start, end] where start >= 1 and end is either -1 (read to EOF) or >= start'
      })
      .optional()
      .describe('Inclusive [startLine, endLine], both 1-indexed positive integers. Use -1 ONLY as the endLine sentinel (read to end of file). Never use -1 as start — start must be >= 1.')
  }
})
