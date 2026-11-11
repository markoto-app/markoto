// Codes every route can answer with: validation, sign-in, access, not-found, rate limit, 5xx.
// Texts: `apiErrors.<prefix>.<slug>` in i18n/locales/errors/<locale>.json (`internal` → `apiErrors.common.internal`).
import { z } from 'zod'
import { defineErrorCodes, fieldIssue } from './define'

export const commonErrors = defineErrorCodes({
  'request/invalid': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }), audience: 'developer' },
  'request/too-large': { status: 413 },
  'auth/required': { status: 401 },
  'auth/forbidden': { status: 403 },
  'resource/not-found': { status: 404 },
  'rate/limited': { status: 429 },
  'internal': { status: 500 },
  'internal/forbidden': { status: 403, audience: 'developer' }
})
