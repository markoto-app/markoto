// Unified error surfacing for $fetch / API-call catches.
//
// Every catch block in components used to do one of three things:
//   1. toast with a translation key + err.data?.message fallback
//   2. console.error only (silent to the user)
//   3. silent swallow that left the UI in a loading state forever
//
// This composable forces everyone through (1) so we don't ship silent
// failures. It also reads the server's `data.messageKey` when present
// (see §D in the defensive-coding audit) and prefers that over the raw
// English server message — so non-English locales get localised errors
// rather than a verbatim statusMessage.
//
// Wrapped in `createSharedComposable` so the toast + i18n lookups are
// shared across the 6+ consumer components (modals, panels, pages) —
// they all hit the same toast queue and share one i18n instance,
// auto-cleaned via tryOnScopeDispose when no consumer remains.

import { createSharedComposable } from '@vueuse/core'
import { loginPath, type LoginProvider } from '~~/shared/config/instance'
import { isPlanErrorCode } from '~~/shared/config/planErrors'

/** Server code for "this action needs a fresh sign-in" (server/utils/sessionPolicy.ts). */
export const REAUTH_REQUIRED_CODE = 'auth/reauth-required'

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

  /**
   * Resolve an i18n key if it exists, otherwise return the fallback.
   * `te` = "translation exists" — avoids logging missing-key warnings
   * when we probe for optional keys.
   */
  function tOrFallback(key: string, fallback: string): string {
    return te(key) ? t(key) : fallback
  }

  /**
   * Pull a sensible {statusCode, message, code, recovery} out of
   * whatever shape $fetch, useFetch, or a raw error handed us.
   */
  function extractError(err: unknown): ExtractedError {
    const e = (err ?? {}) as FetchErrorLike
    const statusCode = e.statusCode ?? e.status ?? e.data?.statusCode ?? null
    const code = e.data?.code ?? null
    const recovery = e.data?.recovery ?? null

    // Prefer server-provided i18n key → translate. Otherwise fall back
    // to the raw message (which may be in English — acceptable for
    // English locale, imperfect for others but still informative).
    const messageKey = e.data?.messageKey
    const rawMessage = e.data?.message ?? e.message ?? null
    const message = messageKey
      ? tOrFallback(messageKey, rawMessage ?? t('error.generic'))
      : rawMessage ?? t('error.generic')

    return { statusCode, message, code, recovery }
  }

  /**
   * Show an error toast with the given title key and the extracted
   * server message as description. Optional action adds a button
   * (e.g. "Upgrade" linking to /pricing).
   */
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
   * Pick a toast variant automatically based on the server status code.
   * 401/403 → "please sign in / no permission" toast with no custom
   * title; 402 → budget-exhausted with Upgrade CTA; 404 → "not found";
   * 429 → rate-limit; otherwise falls back to the given default title.
   *
   * Most call sites should prefer this over raw `showError` so the
   * 402 + upgrade-CTA path is automatic.
   */
  function showContextualError(err: unknown, defaultTitleKey: string): ExtractedError {
    const extracted = extractError(err)
    const sc = extracted.statusCode

    if (sc === 401) return showError('error.unauthorized', err)
    if (sc === 403) return showError('error.forbidden', err)
    if (sc === 404) return showError('error.notFound', err)
    if (sc === 429) return showError('error.rateLimited', err)

    // Plan limit / feature not in the plan (server/utils/entitlements.ts):
    // a dedicated title plus the server's recovery link (Upgrade, or
    // "paid plans coming soon"); self-hosted instances send none.
    if (isPlanErrorCode(extracted.code)) {
      const recovery = extracted.recovery
      const href = recovery?.kind === 'link' ? recovery.href : undefined
      return showError('plan.limitTitle', err, href && recovery?.labelKey
        ? { label: t(recovery.labelKey), color: 'neutral', onClick: () => { void navigateTo(href) } }
        : undefined)
    }

    // 402 intentionally falls through to the caller — the budget-exhausted
    // flow has a specific CTA (/pricing link) that depends on context
    // (workspace vs personal quota). `useAI` handles this explicitly.

    return showError(defaultTitleKey, err)
  }

  const { user } = useUserSession()
  const { primaryLoginPath } = useInstanceConfig()

  /**
   * Sensitive actions (account deletion, data export, AI provider
   * changes) answer 401 `auth/reauth-required` when the sign-in is
   * older than the server allows. Show a "Sign in again" toast that
   * restarts the login flow of the provider the user signed in with.
   * Returns true when the error was that case (caller skips its own
   * toast), false otherwise.
   */
  function handleReauthRequired(err: unknown): boolean {
    const extracted = extractError(err)
    if (extracted.code !== REAUTH_REQUIRED_CODE) return false
    // An SSO session signs in again through its workspace's IdP, not a
    // provider button: no direct provider link for it.
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
