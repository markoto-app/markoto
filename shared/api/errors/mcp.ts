// Error codes `mcp/*`. Texts: `apiErrors.mcp.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const mcpErrors = defineErrors('mcp', {
  'doc-not-found': { status: 404 },
  'invalid-token-request': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'missing-doc-id': { status: 400, audience: 'developer' },
  'missing-workspace-id': { status: 400, audience: 'developer' },
  'render-rate-limited': { status: 429 },
  // MCP clients are agents and scripts: the limit and its window tell them how long to back off.
  'tool-call-limit': { status: 429, params: z.object({ limit: z.number(), minutes: z.number(), tool: z.string().optional() }) },
  'too-many-open-docs': { status: 429, params: z.object({ max: z.number() }) },
  'too-many-tokens': { status: 429 },
  'token-not-found': { status: 404 },
  'tool-not-found': { status: 404, audience: 'developer', params: z.object({ tool: z.string() }) },
  'unauthenticated': { status: 401 },
  'workspace-not-found': { status: 404 }
})
