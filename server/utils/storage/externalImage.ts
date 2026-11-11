// External image fetch for the `view_image` tool (and image URLs that
// `fetch_url` extraction or a BYOK `generate_image` response hand back).
// The URL comes from the model, a page, a document or a third-party API,
// so the fetch goes through `safeFetch`: every hop re-checked, connection
// pinned to the checked address, redirects capped, body size-capped.

import { parseToolUrl } from '../agentic/urlGuard'
import { readBodyCapped, safeFetch, type SafeFetchOptions } from '../platform/safeFetch'
import { MIB } from '~~/shared/config/units'

export interface ExternalImageLimits {
  allowedTypes: ReadonlySet<string>
  maxBytes: number
  /** Overall deadline for all hops + the body. Default 10 s. */
  timeoutMs?: number
}

export type ExternalImageResult = { bytes: Uint8Array, mimeType: string } | { error: string }

/** Redirect hops followed for an image URL (CDNs redirect once or twice). */
const MAX_IMAGE_REDIRECTS = 3

export async function fetchExternalImage(
  url: string,
  limits: ExternalImageLimits,
  deps: Pick<SafeFetchOptions, 'resolve' | 'fetchImpl'> = {}
): Promise<ExternalImageResult> {
  let href: string
  try {
    href = parseToolUrl(url).href
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'URL refused' }
  }
  const mb = limits.maxBytes / MIB
  // 10s hard cap — an AI session that's already racing the 5-minute
  // deadline shouldn't spend a whole minute on one image fetch.
  const signal = AbortSignal.timeout(limits.timeoutMs ?? 10_000)
  try {
    const { response } = await safeFetch(href, { ...deps, signal, maxRedirects: MAX_IMAGE_REDIRECTS })
    if (!response.ok) {
      await response.body?.cancel()
      return { error: `Remote returned HTTP ${response.status}.` }
    }
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!limits.allowedTypes.has(mimeType)) {
      await response.body?.cancel()
      return { error: `Remote returned content-type "${mimeType || '(none)'}". Allowed: ${[...limits.allowedTypes].join(', ')}.` }
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (contentLength && contentLength > limits.maxBytes) {
      await response.body?.cancel()
      return { error: `Remote image is ${Math.round(contentLength / 1024)}KB, which exceeds the ${mb}MB limit.` }
    }
    const bytes = await readBodyCapped(response, limits.maxBytes)
    if (!bytes) return { error: `Remote image exceeded the ${mb}MB limit after fetch.` }
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    // Guard refusals already read "URL refused: …".
    return { error: msg.startsWith('URL refused') ? msg : `Failed to fetch image: ${msg}` }
  }
}
