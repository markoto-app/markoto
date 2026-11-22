import type { H3Event } from 'h3'
import { getCookie, getRequestHeader } from 'h3'
import { asAppLocale, type AppLocale } from '~~/shared/utils/documents/duplicateTitle'

/** Cookie the UI (`@nuxtjs/i18n`) keeps the chosen language in. */
const LOCALE_COOKIE = 'ypad_locale'

/**
 * The UI language of the caller, for text the server writes on their behalf
 * (a duplicate's title, a new document's language): the language cookie the
 * app sets, else the account's stored locale, else the browser's
 * `Accept-Language`. Null when none of them names a UI locale.
 */
export function requestLocale(event: H3Event, accountLocale?: string | null): AppLocale | null {
  const fromCookie = asAppLocale(getCookie(event, LOCALE_COOKIE))
  if (fromCookie) return fromCookie
  const fromAccount = asAppLocale(accountLocale)
  if (fromAccount) return fromAccount
  const header = getRequestHeader(event, 'accept-language') ?? ''
  for (const part of header.split(',')) {
    const found = asAppLocale(part.split(';')[0]?.trim())
    if (found) return found
  }
  return null
}
