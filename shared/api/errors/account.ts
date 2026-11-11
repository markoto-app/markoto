// Error codes `account/*`. Texts: `apiErrors.account.<slug>` in i18n/locales/errors/<locale>.json.
import { defineErrors } from './define'

export const accountErrors = defineErrors('account', {
  'delete-cancel-conflict': { status: 409, statuses: [404] },
  'delete-conflict': { status: 409, statuses: [404] },
  'delete-rate-limited': { status: 429 },
  'sessions-revoke-rate-limited': { status: 429 }
})
