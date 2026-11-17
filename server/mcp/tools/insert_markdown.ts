import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { InsertMarkdownArgs } from '../../utils/ai/tools/structuralEditTools'

// MCP-side `insert_markdown`: the in-app tool's arguments plus `doc_id`, gated on
// `documents:write` and the user's edit access, like replace_text. One
// Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'insert_markdown',
  description: 'Insert Markdown relative to a section of a document: start (after its heading), end (after its subsections), before or after the whole section; without a section at the start or end of the document. Blank lines around blocks are added.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...InsertMarkdownArgs.shape
  }
})
