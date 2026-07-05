import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'

// `web_search` is a 2-call pattern (Staan search → Mistral synthesis).
// The synthesis bills against the caller's LiteLLM virtual key
// (max_budget-bounded); the search call is on a shared key. The 60/hour
// per-user cap bounds the shared-key search surface — MCP has no
// runLoop session caps like the in-app loop.
export default buildUserOnlyTool({
  name: 'web_search',
  description: 'Search the web for up-to-date information with cited sources. Returns a synthesised answer + a deduped source list.',
  scope: 'web:fetch',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  rateLimit: { namespace: 'mcp-web-tools', max: 60, windowMs: 60 * 60 * 1000 },
  inputSchema: {
    query: z.string().min(1).describe('Natural-language search query.')
  }
})
