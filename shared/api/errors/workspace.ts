// Error codes `workspace/*`. Texts: `apiErrors.workspace.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const workspaceErrors = defineErrors('workspace', {
  'not-found': { status: 404 },
  'already-member': { status: 409 },
  'cap-reached': { status: 409, params: z.object({ cap: z.number().optional(), plan: z.string().optional(), recovery: recoveryParam.optional() }) },
  'dpa-required': { status: 409, params: z.object({ currentDpaVersion: z.unknown().optional() }) },
  'guest-cannot-create': { status: 403 },
  'guest-cap': { status: 409, params: z.object({ limit: z.number().optional() }) },
  'invalid-email': { status: 400 },
  'invite-cap': { status: 409, params: z.object({ limit: z.number().optional() }) },
  'invite-not-found': { status: 404 },
  'invite-rate-limited': { status: 429 },
  'role-required': { status: 403 },
  'template-rate-limited': { status: 429 }
})
