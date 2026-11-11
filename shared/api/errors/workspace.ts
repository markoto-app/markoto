// Error codes `workspace/*`. Texts: `apiErrors.workspace.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const workspaceErrors = defineErrors('workspace', {
  'not-found': { status: 404 },
  'admin-required': { status: 403 },
  'already-member': { status: 409 },
  'billing-not-configured': { status: 503 },
  'cap-reached': { status: 409, params: z.object({ cap: z.number(), plan: z.string(), recovery: recoveryParam.optional() }) },
  'dpa-required': { status: 409, params: z.object({ currentDpaVersion: z.unknown().optional() }) },
  'guest-cannot-create': { status: 403 },
  'guest-role-change': { status: 409 },
  'guest-cap': { status: 409, params: z.object({ limit: z.number().optional() }) },
  'invalid-email': { status: 400 },
  'invite-cap': { status: 409, params: z.object({ limit: z.number().optional() }) },
  'invite-not-found': { status: 404 },
  'invite-rate-limited': { status: 429 },
  'last-admin': { status: 409 },
  'member-not-found': { status: 404 },
  'role-required': { status: 403 },
  'template-rate-limited': { status: 429 }
})
