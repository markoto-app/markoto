import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { ReplaceAllArgs } from '../../utils/ai/tools/structuralEditTools'

// MCP-side `replace_all`: the in-app tool's arguments plus `doc_id`, gated on
// `documents:write` and the user's edit access, like replace_text. One
// Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'replace_all',
  description: 'Replace every occurrence of a word, phrase or regular expression in a document in one edit. preview (default true) reports the count, skipped occurrences (code, math, URLs, link targets are left alone by default), the first diffs and match ids without changing anything; preview false applies, optionally only the matchIds given. Case is preserved by default; renamed headings keep their old anchor.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...ReplaceAllArgs.shape
  }
})
