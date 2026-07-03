import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'

// User-only — lists the caller's saved theme presets. Optionally
// includes a workspace's default theme if `workspace_id` is provided.
export default buildUserOnlyTool({
  name: 'list_themes',
  description: 'List the caller\'s saved theme presets. Optionally include a workspace\'s default theme.',
  scope: 'documents:read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    workspace_id: z.string().optional().describe('Optional. If provided, also returns the workspace\'s default theme. Caller must be a member.')
  }
})
