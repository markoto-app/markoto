// Error codes `ai/*`. Texts: `apiErrors.ai.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const aiErrors = defineErrors('ai', {
  'abort-not-initiator': { status: 403 },
  'budget-exhausted': { status: 402, params: z.object({ recovery: recoveryParam.optional() }) },
  'confirmation-not-pending': { status: 409 },
  'duplicate-session': { status: 409 },
  'free-allowance-exhausted': { status: 402, params: z.object({ recovery: recoveryParam.optional() }) },
  'provider-error': { status: 502 },
  'provider-missing': { status: 409, params: z.object({ capability: z.string().optional(), recovery: recoveryParam.optional() }) },
  'session-not-found': { status: 404 },
  'web-tools-rate-limited': { status: 429, params: z.object({ limit: z.number(), window: z.string(), recovery: recoveryParam.optional() }) }
})
