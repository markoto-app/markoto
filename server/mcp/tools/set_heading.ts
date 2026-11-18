import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { SetHeadingArgs } from '../../utils/ai/tools/structuralEditTools'

// MCP-side `set_heading`: the in-app tool's arguments plus `doc_id`, gated on
// `documents:write` and the user's edit access, like replace_text. One
// Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'set_heading',
  description: 'Change a heading\'s level and/or text in a document. Its {#id} attribute block is kept; when the text changes, links in the document to the heading follow its new anchor.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...SetHeadingArgs.shape
  }
})
