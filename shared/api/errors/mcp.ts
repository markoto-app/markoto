// Error codes `mcp/*`. Texts: `apiErrors.mcp.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const mcpErrors = defineErrors('mcp', {
  'doc-not-found': { status: 404 },
  'invalid-token-request': { status: 400, params: z.object({ issues: z.unknown().optional() }) },
  'missing-doc-id': { status: 400, audience: 'developer' },
  'missing-workspace-id': { status: 400, audience: 'developer' },
  'rate-limited': { status: 429 },
  'render-rate-limited': { status: 429 },
  'too-many-open-docs': { status: 429 },
  'too-many-tokens': { status: 429 },
  'tool-not-found': { status: 404, audience: 'developer' },
  'unauthenticated': { status: 401 },
  'workspace-not-found': { status: 404 }
})
