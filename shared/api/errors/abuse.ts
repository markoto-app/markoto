// Error codes `abuse/*`. Texts: `apiErrors.abuse.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const abuseErrors = defineErrors('abuse', {
  'already-closed': { status: 409, params: z.object({ status: z.string() }) },
  'conflict': { status: 409 },
  'login-required': { status: 401 },
  'rate-limited': { status: 429 },
  'report-not-found': { status: 404 },
  'invalid-category': { status: 400 },
  'url-required': { status: 400 },
  'body-too-short': { status: 400 },
  'body-too-long': { status: 400 },
  'good-faith-required': { status: 400 },
  'invalid-email': { status: 400 },
  'contact-required': { status: 400 },
  'decision-explanation': { status: 400, params: z.object({ min: z.number(), max: z.number() }) },
  'decision-action': { status: 400 },
  'decision-rule': { status: 400 }
})
