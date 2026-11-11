// Error codes `mcp/*`. Texts: `apiErrors.mcp.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const mcpErrors = defineErrors('mcp', {
  'doc-not-found': { status: 404 },
  'invalid-token-request': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'missing-doc-id': { status: 400, audience: 'developer' },
  'missing-workspace-id': { status: 400, audience: 'developer' },
  'rate-limited': { status: 429 },
  'render-rate-limited': { status: 429 },
  'too-many-open-docs': { status: 429 },
  'too-many-tokens': { status: 429 },
  'token-not-found': { status: 404 },
  'tool-not-found': { status: 404, audience: 'developer' },
  'unauthenticated': { status: 401 },
  'workspace-not-found': { status: 404 }
})
