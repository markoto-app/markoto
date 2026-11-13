// Error codes `ai-provider/*`. Texts: `apiErrors.ai-provider.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const aiProviderErrors = defineErrors('ai-provider', {
  'invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'key-required': { status: 400 },
  'not-configured': { status: 404 },
  'rate-limited': { status: 429 },
  // `messageKey` names the per-reason text the client shows (see app/utils/api/errors.ts).
  'url-refused': { status: 422, params: z.object({ reason: z.string().optional(), messageKey: z.string().optional() }) },
  'verify-failed': { status: 422, params: z.object({ reason: z.string().optional(), messageKey: z.string().optional() }) }
})
