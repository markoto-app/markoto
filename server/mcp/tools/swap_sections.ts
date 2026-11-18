import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { SwapSectionsArgs } from '../../utils/ai/tools/structuralEditTools'

// MCP-side `swap_sections`: the in-app tool's arguments plus `doc_id`, gated
// on `documents:write` and the user's edit access, like move_section. One
// Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'swap_sections',
  description: 'Swap two sections of a document, each with its subsections, in one edit on the server, adjacent or far apart. Refused when one contains the other. Comment threads inside both move along; section ids stay with their sections. Headings keep their numbers; put them in order with renumber_headings.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...SwapSectionsArgs.shape
  }
})
