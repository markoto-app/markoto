// Unified error surfacing for $fetch / API-call catches.
//
// Catch blocks should toast (a translation key + the server message as
// description) rather than only console.error or swallow the failure, which
// leaves the UI loading forever.
//
// Text, most precise first (app/utils/api/errors.ts): a per-occurrence key
// (plan feature, provider refusal), the registered code's text
// (`apiErrors.<ns>.<slug>`, shared/api/errors/), the route's `messageKey`,
// a status-based text (`error.forbidden`, ...), `error.generic`. The server's
// English `message` is never shown.
//
// `createSharedComposable` shares the toast + i18n lookups across consumers
// and cleans up when the last one unmounts.

import { createSharedComposable } from '@vueuse/core'
import { loginPath, type LoginProvider } from '~~/shared/config/instance'
import { isPlanErrorCode } from '~~/shared/config/planErrors'
import { REAUTH_REQUIRED_CODE } from '~~/shared/config/reauth'
import { apiErrorData, errorStatus, fieldErrors, resolveErrorMessage, type FieldErrorText } from '~~/app/utils/api/errors'
import { isApiErrorCode, type ApiErrorCode } from '~~/shared/api/errors'

interface FetchErrorLike {
  statusCode?: number
  status?: number
  data?: {
    statusCode?: number
    message?: string
    /** Stable machine code, e.g. 'ai/budget-exhausted'. */
    code?: string
    /** i18n key the client should look up instead of showing raw message. */
    messageKey?: string
    /** Recovery hint the UI can render (e.g. link to /pricing). */
    recovery?: {
      kind: 'link' | 'retry' | 'contact'
      href?: string
      labelKey?: string
    }
    [key: string]: unknown
  }
  message?: string
}

export interface ExtractedError {
  statusCode: number | null
  /** Localised message, already passed through `t(...)` when applicable. */
  message: string
  /** The server's machine code when it is a registered one (every code the API sends is, see shared/api/errors). */
  code: ApiErrorCode | null
  recovery: FetchErrorLike['data'] extends undefined
    ? null
    : NonNullable<FetchErrorLike['data']>['recovery'] | null
  /** Per-field texts of a validation error (`data.fields`), already translated. */
  fields: Array<{ path: string, message: string }>
}

export interface ToastAction {
  label: string
  onClick: () => void
  color?: 'primary' | 'neutral' | 'error' | 'warning' | 'success'
}

function useErrorHandlerImpl() {
  const toast = useToast()
  const { t, te } = useI18n()

  /** Accepts whatever shape $fetch, useFetch or a raw error produces. */
  function extractError(err: unknown): ExtractedError {
    const e = (err ?? {}) as FetchErrorLike
    const statusCode = errorStatus(e)
    // `$fetch` nests our fields one level down (`e.data.data`); apiErrorData unwraps either shape.
    const data = apiErrorData(e)
    const code = isApiErrorCode(data?.code) ? data.code : null
    const recovery = (data?.recovery ?? null) as ExtractedError['recovery']
    const message = resolveErrorMessage(err, { t, te })
    const fields = fieldErrors(data)
      .filter((f: FieldErrorText) => te(f.key))
      .map(f => ({ path: f.path, message: t(f.key, f.params) }))

    return { statusCode, message, code, recovery, fields }
  }

  /**
   * A billing change that waits for its payment (`billing/payment-pending`)
   * carries the link to Stripe's page for the invoice: the toast's button.
   */
  function pendingPaymentAction(extracted: ExtractedError): ToastAction | undefined {
    const recovery = extracted.recovery
    if (extracted.code !== 'billing/payment-pending' || recovery?.kind !== 'link' || !recovery.href || !recovery.labelKey) return undefined
    const href = recovery.href
    return {
      label: t(recovery.labelKey),
      color: 'neutral',
      onClick: () => {
        globalThis.location.href = href
      }
    }
  }

  /**
   * The way forward a refused limit carries (`recovery`, set by the server
   * through `limitRecovery()`: "Upgrade" with billing on, the coming-soon
   * page while paid plans are announced, nothing on a self-hosted
   * instance), as a toast button. Plan errors, image and knowledge storage
   * quotas and the workspace cap all carry it.
   */
  function recoveryAction(err: unknown): ToastAction | undefined {
    const extracted = extractError(err)
    const recovery = extracted.recovery
    if (extracted.code === 'billing/payment-pending' || recovery?.kind !== 'link' || !recovery.href || !recovery.labelKey) return undefined
    const href = recovery.href
    return {
      label: t(recovery.labelKey),
      color: 'neutral',
      onClick: () => {
        void navigateTo(href)
      }
    }
  }

  /**
   * The optional action adds a button (e.g. "Upgrade" linking to /pricing);
   * without one, a pending payment's "Complete payment" link is the button.
   */
  function showError(
    titleKey: string,
    err: unknown,
    action?: ToastAction
  ): ExtractedError {
    const extracted = extractError(err)
    const button = action ?? pendingPaymentAction(extracted)
    toast.add({
      title: t(titleKey),
      description: extracted.message,
      icon: 'i-lucide-alert-circle',
      color: 'error',
      actions: button ? [button] : undefined
    })
    return extracted
  }

  /**
   * Picks the toast title from the status code (401, 403, 404, 429, plan
   * errors), else `defaultTitleKey`. Prefer this over raw `showError`.
   */
  function showContextualError(err: unknown, defaultTitleKey: string): ExtractedError {
    const extracted = extractError(err)
    const sc = extracted.statusCode

    if (sc === 401) return showError('error.unauthorized', err)
    if (sc === 403) return showError('error.forbidden', err)
    if (sc === 404) return showError('error.notFound', err)
    if (sc === 429) return showError('error.rateLimited', err)

    // Plan limit / feature not in the plan (server/utils/billing/entitlements.ts):
    // the server's recovery link (Upgrade, or "coming soon") becomes the action;
    // self-hosted instances send none.
    if (isPlanErrorCode(extracted.code)) {
      return showError('plan.limitTitle', err, recoveryAction(err))
    }

    // 402 falls through: the budget-exhausted CTA depends on context
    // (workspace vs personal quota), which `useAI` handles. Other limits
    // (storage quotas, the workspace cap) carry their own recovery link.

    return showError(defaultTitleKey, err, recoveryAction(err))
  }

  const { user } = useUserSession()
  const { primaryLoginPath } = useInstanceConfig()

  /**
   * Sensitive actions (account deletion, data export, AI provider changes)
   * answer 401 `auth/reauth-required` when the sign-in is too old. Shows a
   * "Sign in again" toast and returns true (the caller skips its own toast).
   */
  function handleReauthRequired(err: unknown): boolean {
    const extracted = extractError(err)
    if (extracted.code !== REAUTH_REQUIRED_CODE) return false
    // An SSO session re-authenticates through its workspace's IdP, so there is no provider link.
    const sessionProvider = user.value?.provider
    const provider: LoginProvider | undefined = sessionProvider === 'sso' ? undefined : sessionProvider
    const target = provider ? loginPath(provider) : primaryLoginPath.value
    toast.add({
      title: t('auth.reauthTitle'),
      description: extracted.message,
      icon: 'i-lucide-lock',
      color: 'neutral',
      actions: target
        ? [{
            label: t('auth.reauthAction'),
            color: 'neutral',
            onClick: () => {
              // Hard navigation: the OAuth flow is a server redirect.
              globalThis.location.href = target
            }
          }]
        : undefined
    })
    return true
  }

  return {
    extractError,
    pendingPaymentAction,
    recoveryAction,
    showError,
    showContextualError,
    handleReauthRequired
  }
}

export const useErrorHandler = createSharedComposable(useErrorHandlerImpl)
