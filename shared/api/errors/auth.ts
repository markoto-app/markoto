// Error codes `auth/*`. Texts: `apiErrors.auth.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const authErrors = defineErrors('auth', {
  'oidc-disabled': { status: 404 },
  'oidc-failed': { status: 401 },
  'oidc-misconfigured': { status: 503 },
  'oidc-unavailable': { status: 502 },
  'reauth-required': { status: 401 }
})
