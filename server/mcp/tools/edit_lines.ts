import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { EditLinesArgs } from '../../utils/ai/tools/structuralEditTools'

// MCP-side `edit_lines`: the in-app tool's arguments plus `doc_id`, gated on
// `documents:write` and the user's edit access, like replace_text. One
// Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'edit_lines',
  description: 'Replace several line ranges of a document in one call, all numbered against one doc rev (base_rev from outline, read_section or search_document). Applied bottom-up; refused when the document changed or an expected_first_line does not match.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...EditLinesArgs.shape
  }
})
