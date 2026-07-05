import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'

// `fetch_url` is a 2-call pattern (Jina Reader → Mistral synthesis with
// json_schema strict). Returns `{summary, images[]}`. The synthesis
// bills against the caller's LiteLLM virtual key (max_budget-bounded);
// the Jina Reader call is on a shared key. Shares the 60/hour
// `mcp-web-tools` per-user cap with `web_search`. SSRF-guarded by
// `assertSafeUrl` inside the handler.
export default buildUserOnlyTool({
  name: 'fetch_url',
  description: 'Fetch a specific URL, extract its readable text content + visible image URLs, and return a structured {summary, images[]} synthesis.',
  scope: 'web:fetch',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  rateLimit: { namespace: 'mcp-web-tools', max: 60, windowMs: 60 * 60 * 1000 },
  inputSchema: {
    url: z.string().trim().min(1).max(2048).describe('The URL to fetch. Any public web page. Missing scheme is treated as https://. Do not pass /api/files/... paths.')
  }
})
