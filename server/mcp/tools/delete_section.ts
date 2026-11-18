import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { DeleteSectionArgs } from '../../utils/ai/tools/structuralEditTools'

// MCP-side `delete_section`: the in-app tool's arguments plus `doc_id`, gated on
// `documents:write` and the user's edit access, like replace_text. One
// Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'delete_section',
  description: 'Delete a section of a document with its subsections. Pass expected_rev to refuse when it changed since you read it.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...DeleteSectionArgs.shape
  }
})
