// Byte ranges for the bundled videos (the product tour's clips under
// /tour/). Nitro's static handler always answers 200 with the whole file.
// Safari refuses to play a <video> from a server that ignores Range, and
// other browsers cannot seek without downloading the file again. The static
// handler runs before any app middleware, so the range is cut from its
// answer in the server entry (bunEntry.ts).

const VIDEO_PATH = /\.(mp4|webm)$/i
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/

/** The inclusive byte span a Range header asks for, or null when it cannot be satisfied. */
export function resolveByteRange(header: string, size: number): { start: number, end: number } | null {
  const match = SINGLE_RANGE.exec(header.trim())
  if (!match || size === 0) return null
  const [, from = '', to = ''] = match
  if (from === '' && to === '') return null
  // `bytes=-N`: the last N bytes.
  if (from === '') {
    const suffix = Number(to)
    if (suffix === 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(from)
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (start >= size || start > end) return null
  return { start, end }
}

/**
 * Turn the full answer for a video file into the requested range (206), or
 * 416 when the range lies outside the file. Anything that is not a
 * successful GET of a video passes through unchanged.
 */
export async function withByteRange(method: string, pathname: string, rangeHeader: string | null, response: Response): Promise<Response> {
  if (method !== 'GET' || response.status !== 200 || !VIDEO_PATH.test(pathname)) return response
  const headers = new Headers(response.headers)
  headers.set('Accept-Ranges', 'bytes')
  if (!rangeHeader) return new Response(response.body, { status: 200, headers })

  const body = new Uint8Array(await response.arrayBuffer())
  const range = resolveByteRange(rangeHeader, body.byteLength)
  if (!range) {
    headers.set('Content-Range', `bytes */${body.byteLength}`)
    headers.delete('Content-Length')
    return new Response(null, { status: 416, headers })
  }
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${body.byteLength}`)
  headers.set('Content-Length', String(range.end - range.start + 1))
  return new Response(body.subarray(range.start, range.end + 1), { status: 206, headers })
}
