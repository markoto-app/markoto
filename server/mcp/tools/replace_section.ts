import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { ReplaceSectionArgs } from '../../utils/ai/tools/structuralEditTools'

// MCP-side `replace_section`: the in-app tool's arguments plus `doc_id`, gated on
// `documents:write` and the user's edit access, like replace_text. One
// Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'replace_section',
  description: 'Rewrite one section of a document (by section id from outline, number or heading text): everything under its heading, subsections included, or the whole section with keep_heading false. Only changed words are touched, so comments on unchanged text survive. Pass expected_rev to refuse the edit when the section changed since you read it.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...ReplaceSectionArgs.shape
  }
})
