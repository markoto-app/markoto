import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// Doc-bound — handler reads ctx.ytext.toJSON(). Wrapper does
// view-access authz + YDocPool checkout to give the handler a synced
// ytext. Returns the raw markdown string (no line-number prefixes).
//
// Distinct from view_document, which is for AI inspection (line
// numbers help the model reason about positions). This is the
// "give me the doc body" tool — for delivery / archival / piping.
export default buildDocBoundTool({
  name: 'export_document_as_markdown',
  description: 'Read a document\'s full markdown body without line-number prefixes. Use to deliver the doc to the user as text, archive a snapshot, or feed it into another tool. For AI inspection, use view_document instead (it adds line numbers for position-aware editing).',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id to export.')
  }
})
