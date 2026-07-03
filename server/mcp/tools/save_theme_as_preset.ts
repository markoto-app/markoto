import { z } from 'zod'
import { buildDocBoundTool } from '../lib/wrapDocBoundTool'

// `access: 'view'` — the handler READS the current doc's theme then
// saves to the user's personal preset table. It doesn't mutate the
// doc. View access to the source doc is enough.
export default buildDocBoundTool({
  name: 'save_theme_as_preset',
  description: 'Save the document\'s CURRENT theme as one of the user\'s personal presets, available across all their documents. Per-user cap is 20 saved themes.',
  scope: 'documents:write',
  access: 'view',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    doc_id: z.string().min(1).describe('The doc whose current theme to snapshot.'),
    name: z.string().trim().min(1).max(80).describe('Name for the new preset (1–80 chars after trimming).')
  }
})
