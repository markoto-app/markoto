import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'

// `fetch_url` is a 2-call pattern (Jina Reader → Mistral synthesis with
// json_schema strict). Returns `{summary, images[]}`. Bills against the
// caller's LiteLLM virtual key. SSRF-guarded by `assertSafeUrl` inside
// the handler.
export default buildUserOnlyTool({
  name: 'fetch_url',
  description: 'Fetch a specific URL, extract its readable text content + visible image URLs, and return a structured {summary, images[]} synthesis.',
  scope: 'web:fetch',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  inputSchema: {
    url: z.string().trim().min(1).max(2048).describe('The URL to fetch. Any public web page. Missing scheme is treated as https://. Do not pass /api/files/... paths.')
  }
})
