// The registry of every error code the API answers with (see docs/contributing/api-handlers.md).
// Each namespace file is owned by the domain that throws its codes; add a code there and its text
// to all six i18n/locales/errors/<locale>.json files (tests/unit/repoHygiene/apiErrorKeys.test.ts).
import type { z } from 'zod'
import type { ErrorSpec, ErrorStatus } from './define'
import { commonErrors } from './common'
import { abuseErrors } from './abuse'
import { accountErrors } from './account'
import { adminErrors } from './admin'
import { aiErrors } from './ai'
import { aiProviderErrors } from './aiProvider'
import { anonGateErrors } from './anonGate'
import { auditErrors } from './audit'
import { authErrors } from './auth'
import { billingErrors } from './billing'
import { brandErrors } from './brand'
import { consentErrors } from './consent'
import { csrfErrors } from './csrf'
import { customDomainErrors } from './customDomain'
import { designImportErrors } from './designImport'
import { docsErrors } from './docs'
import { dpaErrors } from './dpa'
import { exportErrors } from './export'
import { filesErrors } from './files'
import { folderErrors } from './folder'
import { importErrors } from './import'
import { knowledgeErrors } from './knowledge'
import { legalErrors } from './legal'
import { mcpErrors } from './mcp'
import { moderationErrors } from './moderation'
import { onboardingErrors } from './onboarding'
import { passwordErrors } from './password'
import { planErrors } from './plan'
import { publishErrors } from './publish'
import { publishedErrors } from './published'
import { shareErrors } from './share'
import { ssoErrors } from './sso'
import { suggestionErrors } from './suggestion'
import { templateErrors } from './template'
import { themeErrors } from './theme'
import { uploadErrors } from './upload'
import { usageErrors } from './usage'
import { waitlistErrors } from './waitlist'
import { workspaceErrors } from './workspace'

export const API_ERRORS = {
  ...commonErrors,
  ...abuseErrors,
  ...accountErrors,
  ...adminErrors,
  ...aiErrors,
  ...aiProviderErrors,
  ...anonGateErrors,
  ...auditErrors,
  ...authErrors,
  ...billingErrors,
  ...brandErrors,
  ...consentErrors,
  ...csrfErrors,
  ...customDomainErrors,
  ...designImportErrors,
  ...docsErrors,
  ...dpaErrors,
  ...exportErrors,
  ...filesErrors,
  ...folderErrors,
  ...importErrors,
  ...knowledgeErrors,
  ...legalErrors,
  ...mcpErrors,
  ...moderationErrors,
  ...onboardingErrors,
  ...passwordErrors,
  ...planErrors,
  ...publishErrors,
  ...publishedErrors,
  ...shareErrors,
  ...ssoErrors,
  ...suggestionErrors,
  ...templateErrors,
  ...themeErrors,
  ...uploadErrors,
  ...usageErrors,
  ...waitlistErrors,
  ...workspaceErrors
} satisfies Record<string, ErrorSpec>

export type ApiErrorCode = keyof typeof API_ERRORS

/** The `data` fields a code carries next to `code` (`undefined` = none). */
export type ApiErrorParams<C extends ApiErrorCode> = (typeof API_ERRORS)[C] extends { params: infer Z extends z.ZodType } ? z.input<Z> : undefined

/** Statuses a code may be sent with: its `status`, plus `statuses` for codes that already vary. */
export type ApiErrorStatus<C extends ApiErrorCode> = (typeof API_ERRORS)[C] extends { statuses: readonly (infer S extends ErrorStatus)[] } ? (typeof API_ERRORS)[C]['status'] | S : (typeof API_ERRORS)[C]['status']

export function isApiErrorCode(code: unknown): code is ApiErrorCode {
  return typeof code === 'string' && Object.hasOwn(API_ERRORS, code)
}

/** i18n key of a code's text: `apiErrors.<ns>.<slug>`; a code without a namespace lives under `common`. */
export function apiErrorMessageKey(code: string): string {
  const slash = code.indexOf('/')
  return slash === -1 ? `apiErrors.common.${code}` : `apiErrors.${code.slice(0, slash)}.${code.slice(slash + 1)}`
}
