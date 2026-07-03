import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

export default buildDocBoundTool({
  name: 'set_title',
  description: 'Set the document title (1–255 chars). Appears in tab, topbar, listings, and is usable in header/footer templates via the {title} token.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id whose title to set.'),
    title: z.string().trim().min(1).max(255).describe('The new title (1–255 characters after trimming).')
  }
})
