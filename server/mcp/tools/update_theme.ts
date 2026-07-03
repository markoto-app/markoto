import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'
import { UpdateThemeArgs } from '../../utils/agentic/functionTools'

// Reuse the in-app loop's UpdateThemeArgs shape verbatim — there's only
// one source of truth for which theme fields are valid + how each is
// described. `.shape` extracts the ZodRawShape the toolkit expects.
// Adding `doc_id` on top is the only MCP-specific delta.
export default buildDocBoundTool({
  name: 'update_theme',
  description: 'Update the document theme — fonts, colors, page size, layout. Pass partial fields to merge on top of the current theme, or pass `preset` / `theme_id` / `from_workspace_default` (mutually exclusive) to replace the base before merging.',
  scope: 'documents:write',
  access: 'edit',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc id whose theme to update.'),
    ...UpdateThemeArgs.shape
  }
})
