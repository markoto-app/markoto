import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'
import { isWebToolAvailable } from '../../utils/ai/webTools'

// `fetch_url` is a 2-call pattern (Jina Reader → synthesis with json_schema
// strict on the caller's chat provider). Returns `{summary, images[]}`. The
// Jina Reader call is platform-paid: charged to the caller's AI budget
// (`chargeWebToolCall`) and sharing the per-user hourly/daily web-tool
// allowance (`consumeWebToolQuota`) with `web_search` and the in-app loop. Not listed when `JINA_AI_API_KEY` is unset. SSRF-guarded by
// `assertSafeUrl` inside the handler.
export default buildUserOnlyTool({
  name: 'fetch_url',
  description: 'Fetch a specific URL, extract its readable text content + visible image URLs, and return a structured {summary, images[]} synthesis.',
  scope: 'web:fetch',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  available: () => isWebToolAvailable('fetch_url'),
  inputSchema: {
    url: z.string().trim().min(1).max(2048).describe('The URL to fetch. Any public web page. Missing scheme is treated as https://. Do not pass /api/files/... paths.')
  }
})
