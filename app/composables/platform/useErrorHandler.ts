// Unified error surfacing for $fetch / API-call catches.
//
// Catch blocks should toast (a translation key + the server message as
// description) rather than only console.error or swallow the failure, which
// leaves the UI loading forever.
//
// The server's `data.messageKey` is preferred over the raw English message,
// so non-English locales get localised errors.
//
// `createSharedComposable` shares the toast + i18n lookups across consumers
// and cleans up when the last one unmounts.

import { createSharedComposable } from '@vueuse/core'
import { loginPath, type LoginProvider } from '~~/shared/config/instance'
import { isPlanErrorCode } from '~~/shared/config/planErrors'

/** Server code for "this action needs a fresh sign-in" (server/utils/auth/sessionPolicy.ts). */
const REAUTH_REQUIRED_CODE = 'auth/reauth-required'

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
  }
  message?: string
}

export interface ExtractedError {
  statusCode: number | null
  /** Localised message, already passed through `t(...)` when applicable. */
  message: string
  code: string | null
  recovery: FetchErrorLike['data'] extends undefined
    ? null
    : NonNullable<FetchErrorLike['data']>['recovery'] | null
}

export interface ToastAction {
  label: string
  onClick: () => void
  color?: 'primary' | 'neutral' | 'error' | 'warning' | 'success'
}

function useErrorHandlerImpl() {
  const toast = useToast()
  const { t, te } = useI18n()

  /** `te` (translation exists) avoids missing-key warnings when probing optional keys. */
  function tOrFallback(key: string, fallback: string): string {
    return te(key) ? t(key) : fallback
  }

  /** Accepts whatever shape $fetch, useFetch or a raw error produces. */
  function extractError(err: unknown): ExtractedError {
    const e = (err ?? {}) as FetchErrorLike
    const statusCode = e.statusCode ?? e.status ?? e.data?.statusCode ?? null
    const code = e.data?.code ?? null
    const recovery = e.data?.recovery ?? null

    // Without a messageKey the raw message may be English in other locales; still informative.
    const messageKey = e.data?.messageKey
    const rawMessage = e.data?.message ?? e.message ?? null
    const message = messageKey
      ? tOrFallback(messageKey, rawMessage ?? t('error.generic'))
      : rawMessage ?? t('error.generic')

    return { statusCode, message, code, recovery }
  }

  /** The optional action adds a button (e.g. "Upgrade" linking to /pricing). */
  function showError(
    titleKey: string,
    err: unknown,
    action?: ToastAction
  ): ExtractedError {
    const extracted = extractError(err)
    toast.add({
      title: t(titleKey),
      description: extracted.message,
      icon: 'i-lucide-alert-circle',
      color: 'error',
      actions: action ? [action] : undefined
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
      const recovery = extracted.recovery
      const href = recovery?.kind === 'link' ? recovery.href : undefined
      return showError('plan.limitTitle', err, href && recovery?.labelKey
        ? { label: t(recovery.labelKey), color: 'neutral', onClick: () => { void navigateTo(href) } }
        : undefined)
    }

    // 402 falls through: the budget-exhausted CTA depends on context
    // (workspace vs personal quota), which `useAI` handles.

    return showError(defaultTitleKey, err)
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
    showError,
    showContextualError,
    handleReauthRequired
  }
}

export const useErrorHandler = createSharedComposable(useErrorHandlerImpl)
