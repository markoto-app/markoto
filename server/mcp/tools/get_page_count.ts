import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// Calls the renderer sidecar to compute paginated page count under
// the doc's current theme @page rules. Triggers a fresh render if the
// doc hasn't been rendered yet (~5-15s cold-start; cached afterwards).
export default buildDocBoundTool({
  name: 'get_page_count',
  description: 'Return the total number of paginated pages in the document under the current theme. Use when the user references a specific page number to know if it exists, before calling view_pages. Triggers a backend render if uncached.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id to count pages for.')
  }
})
