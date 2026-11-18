import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { RenumberHeadingsArgs } from '../../utils/ai/tools/replaceAllTools'

// MCP-side `renumber_headings`: the in-app tool's arguments plus `doc_id`,
// gated on `documents:write` and the user's edit access, like set_heading.
// One Y.js transaction attributed to the MCP session.
export default buildDocBoundTool({
  name: 'renumber_headings',
  description: 'Renumber every numbered heading of a document in order (1, 1.1, 1.1.1, ...) in one edit, for example after swap_sections or move_section. Only the number in front of each heading changes; levels, titles and {#id} blocks stay, and links in the document to the headings follow. preview true lists the changes without applying them.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id (the slug from /d/<id>) of the document to edit.'),
    ...RenumberHeadingsArgs.shape
  }
})
