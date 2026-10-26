import { z } from 'zod'
import { buildUserOnlyTool } from '../lib/wrapDocBoundTool'
import { isWebToolAvailable } from '../../utils/webTools'

// `web_search` is a 2-call pattern (Staan search → synthesis on the caller's
// chat provider). The synthesis runs on the user's own chat model (BYOK) or
// the instance default; the Staan call is platform-paid and bounded by the
// per-user hourly/daily web-tool allowance (`consumeWebToolQuota`, shared
// with `fetch_url` and the in-app loop). Not listed when `STAAN_API_KEY` is
// unset.
export default buildUserOnlyTool({
  name: 'web_search',
  description: 'Search the web for up-to-date information with cited sources. Returns a synthesised answer + a deduped source list.',
  scope: 'web:fetch',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  available: () => isWebToolAvailable('web_search'),
  inputSchema: {
    query: z.string().min(1).describe('Natural-language search query.')
  }
})
