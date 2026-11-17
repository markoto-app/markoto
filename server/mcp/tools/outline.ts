import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { OutlineArgs } from '../../utils/ai/tools/sectionTools'

// MCP-side `outline`: the in-app tool's arguments plus `doc_id`, gated on
// `documents:read` and the user's view access. Section ids live on the
// pooled connection of the MCP session, so they stay valid across calls.
export default buildDocBoundTool({
  name: 'outline',
  description: 'List the sections of a document: for each heading its id (s-12), number (4.2), level, line range (subsections included), word count and rev (a hash that changes when the section text changes), plus document totals. Start here on a long document, then read sections with read_section or find text with search_document. Ids stay valid while the document is edited, for the rest of this MCP session; line numbers do not.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document.'),
    ...OutlineArgs.shape
  }
})
