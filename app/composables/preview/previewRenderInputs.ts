import type { CustomCssResult } from '~~/shared/types/customCss'
import { sanitizeCustomCssForRender, currentAppOrigins } from '~/utils/preview/customCssLoader'
import { createFileTokenSource, withOwnUploadToken } from '~/utils/preview/previewFrame'

/**
 * The two render inputs of the live preview (`usePagedPreview`) that arrive
 * asynchronously: the image file-access token and the sanitized custom CSS.
 * `render()` stays synchronous (see `pendingRender` there): when an input is
 * missing it starts loading it, returns "not ready" and calls `rerender`
 * once the input is in.
 */

/**
 * Image access token for the opaque-origin iframe (its requests carry no
 * cookie). `tokenFor(needed)` returns the token to use ('' = none needed),
 * or null while one is being fetched.
 */
export function createFileTokenGate(docId: () => string, getDocJwt: (() => Promise<string | null>) | undefined, rerender: () => void) {
  const fileTokens = createFileTokenSource(docId, getDocJwt)
  let pending = false

  function tokenFor(needed: boolean): string | null {
    if (!needed) return ''
    const token = fileTokens.current()
    if (token !== null) return token
    if (!pending) {
      pending = true
      void fileTokens.refresh().finally(() => {
        pending = false
        rerender()
      })
    }
    return null
  }

  return { tokenFor }
}

/**
 * Sanitized custom CSS, keyed by the (docId, file token, raw css) it was
 * made from — own-upload url()s carry the token, so a new token means a new
 * sanitize (every ~13 min). The sanitizer is loaded lazily; documents
 * without custom CSS skip all this.
 */
export function createCustomCssCache(docId: () => string, rerender: () => void) {
  let cachedKey = ''
  let cached: CustomCssResult | undefined
  let pendingKey: string | null = null

  /** True when the cache matches the current theme + token; otherwise starts a refresh. */
  function ready(raw: string, fileToken: string): boolean {
    const id = docId()
    const key = `${id}\n${fileToken}\n${raw}`
    if (key === cachedKey) return true
    if (raw.trim() === '') {
      cached = undefined
      cachedKey = key
      pendingKey = null
      return true
    }
    if (pendingKey === key) return false
    pendingKey = key
    let result: CustomCssResult | undefined
    sanitizeCustomCssForRender(raw, {
      docId: id,
      allowedOrigins: currentAppOrigins(),
      fileUrl: path => withOwnUploadToken(path, id, fileToken)
    })
      .then((res) => {
        result = res
      })
      .catch((err: unknown) => {
        // Fail closed: no custom CSS rather than unsanitized CSS.
        console.warn('[custom css] sanitizer failed to load', err)
      })
      .finally(() => {
        // A newer edit superseded this one; its own run will render.
        if (pendingKey !== key) return
        cached = result
        pendingKey = null
        cachedKey = key
        rerender()
      })
    return false
  }

  return { ready, current: (): CustomCssResult | undefined => cached }
}
