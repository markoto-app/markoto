import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { SearchDocumentArgs } from '../../utils/ai/tools/sectionTools'

// MCP-side `search_document`: the in-app tool's arguments plus `doc_id`,
// gated on `documents:read` and the user's view access. Regular
// expressions pass the same safety checks and time budget as in the editor.
export default buildDocBoundTool({
  name: 'search_document',
  description: 'Find every occurrence of a word, phrase or regular expression in a document. Returns the total count and one line per match (match id, line, section id and heading path, the match marked «like this» in its line). Code, math, URLs and link targets are skipped by default and counted separately; link text is searched. Matches never span lines; page through long results with cursor.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to search.'),
    ...SearchDocumentArgs.shape
  }
})
