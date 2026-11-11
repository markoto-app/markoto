import type { H3Event } from 'h3'
import { checkRateLimit } from '../platform/rateLimit'
import { getClientRateLimitKey } from '../platform/clientIp'

// ONE allowance for every server-side render a client can trigger:
// `GET /api/docs/:id/pdf` and the MCP tools `export_document_as_pdf`,
// `get_page_count`, `view_pages`. A cache miss costs a Playwright render
// (~5-15 s of renderer time), so the same client must not get a second,
// separate budget by switching from the REST route to MCP.
//
// Keyed on the client address like the REST route always was. Fails open
// on Valkey errors and is bypassed in TEST_MODE (see `rateLimit.ts`).

const RENDER_RATE_LIMIT = {
  namespace: 'pdf-download',
  max: 10,
  windowMs: 60_000
} as const

/** Consume one render from the caller's allowance. False = over the limit (answer 429). */
export async function consumeRenderAllowance(event: H3Event): Promise<boolean> {
  return checkRateLimit(RENDER_RATE_LIMIT.namespace, getClientRateLimitKey(event), RENDER_RATE_LIMIT.max, RENDER_RATE_LIMIT.windowMs)
}
