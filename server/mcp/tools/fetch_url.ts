import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'
import { isWebToolAvailable } from '../../utils/ai/webTools'

// `fetch_url` is a 2-call pattern (Staan Fetch → synthesis with json_schema
// strict on the caller's worker model). Returns `{summary, images[]}`, the
// answer to `question`, or (mode "extract") the page Markdown in pages. The
// Staan Fetch call is platform-paid: charged to the caller's AI budget
// (`chargeWebToolCall`) and sharing the per-user hourly/daily web-tool
// allowance (`consumeWebToolQuota`) with `web_search` and the in-app loop. Not listed when `STAAN_API_KEY` is unset. SSRF-guarded by
// `assertSafeUrl` inside the handler.
export default buildUserOnlyTool({
  name: 'fetch_url',
  description: 'Fetch a specific URL, extract its readable text content + visible image URLs, and return a structured {summary, images[]} synthesis (or the answer to `question`, or with mode "extract" the page Markdown in pages).',
  scope: 'web:fetch',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  available: () => isWebToolAvailable('fetch_url'),
  inputSchema: {
    url: z.string().trim().min(1).max(2048).describe('The URL to fetch. Any public web page. Missing scheme is treated as https://. Do not pass /api/files/... paths.'),
    question: z.string().trim().max(500).optional().describe('Mode "answer": what you need from the page; the answer is extracted instead of a general summary.'),
    mode: z.enum(['answer', 'extract']).optional().describe('"answer" (default): summary or answer plus image URLs. "extract": the page Markdown itself, about 8000 characters per page.'),
    page: z.number().int().min(1).max(50).optional().describe('Mode "extract": which page of the Markdown to return (1 = first).')
  }
})
