import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'

// `web_search` is a 2-call pattern (Jina Search → Mistral synthesis).
// Bills against the caller's LiteLLM virtual key. Workspace context is
// optional — used for spend-tagging only.
export default buildUserOnlyTool({
  name: 'web_search',
  description: 'Search the web for up-to-date information with cited sources. Returns a synthesised answer + a deduped source list.',
  scope: 'web:fetch',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  inputSchema: {
    query: z.string().min(1).describe('Natural-language search query.')
  }
})
