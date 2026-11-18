import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { MoveSectionArgs } from '../../utils/ai/tools/structuralEditTools'

// MCP-side `move_section`: the in-app tool's arguments plus `doc_id`, gated on
// `documents:write` and the user's edit access, like replace_text. One
// Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'move_section',
  description: 'Move a section of a document with its subsections before or after another section, or to the end, on the server. Comment threads inside it move along; section ids stay valid, and the target is found again after the cut, so ids from one outline work for several moves. To swap two sections use swap_sections. Headings keep their numbers.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...MoveSectionArgs.shape
  }
})
