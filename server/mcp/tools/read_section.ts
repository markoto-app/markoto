import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { ReadSectionArgs } from '../../utils/ai/tools/sectionTools'

// MCP-side `read_section`: the in-app tool's arguments plus `doc_id`,
// gated on `documents:read` and the user's view access.
export default buildDocBoundTool({
  name: 'read_section',
  description: 'Read one section of a document with 1-indexed line numbers. Name the section by id from outline ("s-12"), by number ("4.2") or by its exact heading text. Subsections are included unless include_subsections is false; a long section ends with the offset_line to continue with.',
  scope: 'documents:read',
  access: 'view',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document.'),
    ...ReadSectionArgs.shape
  }
})
