// Error codes `upload/*`. Texts: `apiErrors.upload.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const uploadErrors = defineErrors('upload', {
  'confirm-in-progress': { status: 409 },
  'content-type-mismatch': { status: 415 },
  'file-too-large': { status: 413 },
  'rate-limited': { status: 429 },
  'size-mismatch': { status: 400 },
  'storage-quota': { status: 409, params: z.object({ recovery: recoveryParam.optional() }) },
  'unsupported-format': { status: 415 }
})
