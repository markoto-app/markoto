// Error codes `knowledge/*`. Texts: `apiErrors.knowledge.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const knowledgeErrors = defineErrors('knowledge', {
  'content-type-mismatch': { status: 415 },
  'editor-required': { status: 403 },
  'empty-upload': { status: 400 },
  'file-too-large': { status: 413, params: z.object({ maxMb: z.number() }) },
  'invalid-key': { status: 400 },
  'key-mismatch': { status: 400, audience: 'developer' },
  'not-found': { status: 404 },
  'not-uploader': { status: 403 },
  'rate-limited': { status: 429 },
  'too-many-pending': { status: 409 },
  'unsupported-format': { status: 415, params: z.object({ ext: z.string(), allowed: z.string() }) },
  'upload-not-found': { status: 404 },
  'user-bytes-cap': { status: 409, params: z.object({ maxMb: z.number(), recovery: recoveryParam.optional() }) },
  'user-file-cap': { status: 409, params: z.object({ max: z.number(), recovery: recoveryParam.optional() }) },
  'workspace-bytes-cap': { status: 409, params: z.object({ maxMb: z.number(), recovery: recoveryParam.optional() }) },
  'workspace-file-cap': { status: 409, params: z.object({ max: z.number(), recovery: recoveryParam.optional() }) }
})
