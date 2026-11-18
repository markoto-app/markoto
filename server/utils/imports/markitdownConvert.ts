import { markitdownAuthHeaders } from '../platform/markitdownAuth'
import { MARKITDOWN_IMPORT_TIMEOUT_MS } from '../../config/markitdown'
import { apiError } from '../api/apiError'
import { useEnv } from '~~/shared/env/load'
import type { IMPORT_CONVERTED_EXTENSIONS } from '~~/shared/config/imports'

export type ConvertedExtension = typeof IMPORT_CONVERTED_EXTENSIONS[number]

/**
 * A converted file's Markdown from the markitdown service; its failures map
 * to the import error codes. `images: true` keeps embedded pictures (DOCX,
 * PPTX, EPUB, HTML) as `data:` URIs, for callers that store them as the
 * document's images; without it markitdown cuts them to a placeholder.
 */
export async function convertWithMarkitdown(body: Blob | Uint8Array, ext: ConvertedExtension, opts: { images?: boolean } = {}): Promise<string> {
  const env = useEnv()
  if (!env.markitdown.url) throw apiError('import/not-configured')

  // Markitdown's converter routing is extension-driven (StreamInfo in
  // markitdown-server/server.py), so the validated extension travels as a
  // query param instead of relying on Content-Type sniffing.
  const url = `${env.markitdown.url}/convert?ext=${encodeURIComponent(ext)}${opts.images ? '&images=1' : ''}`
  const size = body instanceof Blob ? body.size : body.byteLength

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: injectTraceHeaders({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        ...markitdownAuthHeaders()
      }),
      body: body instanceof Blob ? body : new Blob([body as Uint8Array<ArrayBuffer>]),
      signal: AbortSignal.timeout(MARKITDOWN_IMPORT_TIMEOUT_MS)
    })
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    throw apiError(timedOut ? 'import/timeout' : 'import/unavailable')
  }

  if (!response.ok) {
    const errorText = await response.text()
    // 413: an archive would expand past markitdown's limits (zip-bomb guard)
    // or the conversion hit its memory cap; 504: its own timeout.
    if (response.status === 413) throw apiError('import/too-complex')
    if (response.status === 504) throw apiError('import/timeout')
    throw apiError('import/conversion-failed', { detail: errorText.slice(0, 200) }, { status: response.status === 415 ? 415 : 422 })
  }

  return await response.text()
}
