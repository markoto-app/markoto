// Error codes `sso/*`. Texts: `apiErrors.sso.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, fieldIssue } from './define'

export const ssoErrors = defineErrors('sso', {
  'admin-required': { status: 403 },
  'connection-not-found': { status: 404 },
  'domain-not-found': { status: 404 },
  'domain-cap': { status: 409, params: z.object({ max: z.number() }) },
  'domain-exists': { status: 409 },
  'domain-taken': { status: 409 },
  'domain-unverified': { status: 422 },
  'incomplete': { status: 409 },
  'invalid-domain': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'invalid-settings': { status: 400, params: z.object({ field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'misconfigured': { status: 503 },
  'not-configured': { status: 404 },
  'no-connection': { status: 404, statuses: [409] },
  'rate-limited': { status: 429 },
  'required': { status: 403, params: z.object({ loginUrl: z.string().optional(), canManageSso: z.boolean().optional() }) },
  'test-not-admin': { status: 403 },
  'unknown': { status: 404 },
  'not-provisioned': { status: 403 },
  'deactivated': { status: 403 },
  'not-active': { status: 403 },
  'test-mismatch': { status: 403 },
  'no-seat': { status: 403 },
  'member-limit': { status: 403 }
})
