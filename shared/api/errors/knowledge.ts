// Error codes `knowledge/*`. Texts: `apiErrors.knowledge.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const knowledgeErrors = defineErrors('knowledge', {
  'content-type-mismatch': { status: 415 },
  'file-too-large': { status: 413 },
  'rate-limited': { status: 429 },
  'too-many-pending': { status: 409 },
  'user-bytes-cap': { status: 409, params: z.object({ recovery: recoveryParam.optional() }) },
  'user-file-cap': { status: 409, params: z.object({ recovery: recoveryParam.optional() }) },
  'workspace-bytes-cap': { status: 409, params: z.object({ recovery: recoveryParam.optional() }) },
  'workspace-file-cap': { status: 409, params: z.object({ recovery: recoveryParam.optional() }) }
})
