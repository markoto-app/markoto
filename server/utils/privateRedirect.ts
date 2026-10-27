import type { H3Event } from 'h3'

/**
 * `Cache-Control` for responses that are per-viewer: a redirect to a
 * short-lived presigned URL (images, PDFs, exports) is the result of an
 * access decision for THIS caller. No shared cache (a CDN or caching proxy
 * added later) may store it and hand it to another viewer, and the
 * browser has no reason to keep it either.
 */
export const PRIVATE_NO_STORE = 'private, no-store'

/** 302 to a presigned URL, marked uncacheable. */
export function sendPrivateRedirect(event: H3Event, url: string) {
  setResponseHeader(event, 'Cache-Control', PRIVATE_NO_STORE)
  return sendRedirect(event, url, 302)
}
