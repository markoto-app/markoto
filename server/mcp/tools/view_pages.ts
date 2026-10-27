import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// Fetches rendered PNG screenshots of specific pages from the doc and
// inlines them into the tool response. Vision-input cost per image —
// the in-app loop caps this at 3 calls/session; MCP wrappers rely on
// the model's own restraint + the underlying renderer's bytes ceiling.
export default buildDocBoundTool({
  name: 'view_pages',
  description: 'Fetch rendered PNG images of specific pages from a document and inline them into the tool response. Use when the user references a specific page number ("issue on page 3", "is page 1 too dense?") — the markdown gives you the content but not paged.js\'s page boundaries.',
  scope: 'documents:read',
  access: 'view',
  // Server render on a cache miss — shares the REST PDF route's allowance.
  limit: 'render',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id whose rendered pages to fetch.'),
    pages: z.array(z.number().int().min(1).max(50)).min(1).max(5).describe('1-indexed list of page numbers to fetch. Maximum 5 pages per call.')
  }
})
