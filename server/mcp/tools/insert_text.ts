import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

export default buildDocBoundTool({
  name: 'insert_text',
  description: 'Insert text after a specific line in a document (1-indexed; 0 = start of file). A trailing newline is added automatically if not present.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id to edit.'),
    insert_line: z.number().int().min(0).describe('Line number after which to insert. 0 = start of file.'),
    insert_text: z.string().describe('Text to insert. A trailing newline is added automatically if not present.')
  }
})
