// Error codes `anon-gate/*`. Texts: `apiErrors.anon-gate.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const anonGateErrors = defineErrors('anon-gate', {
  'misconfigured': { status: 503 },
  'rate-limited': { status: 429 },
  'terms-required': { status: 403 },
  'unavailable': { status: 503 },
  'bot-check-required': { status: 403 },
  'bot-check-failed': { status: 403 },
  'bot-check-expired': { status: 403 },
  'bot-check-replayed': { status: 403 }
})
