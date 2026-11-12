// Bounded request-body reading for endpoints that take large uploads
// through the app (today: `/api/import`, which anonymous users can call).
//
// The hard limits sit in front of this: Bun's `maxRequestBodySize`
// (server/runtime/bunEntry.ts: the production entry buffers every body
// before routing, so only the runtime can refuse one in time) and
// Traefik's buffering middleware on `/api/import` (prod + self-host
// compose). This helper is the endpoint-level check that holds in every
// runtime (dev server, tests): the declared `Content-Length` is checked
// before reading and the stream is counted while reading, so a chunked
// or lying request never yields more than `maxBytes`.

import { createError, getRequestHeader, getRequestWebStream, type H3Event } from 'h3'
import { readStreamWithCap } from './streamCap'
import { MIB } from '~~/shared/config/units'

function tooLarge(maxBytes: number, code: string): Error {
  return createError({
    statusCode: 413,
    message: `Request body too large. Max ${Math.floor(maxBytes / MIB)}MB.`,
    data: { code }
  })
}

/** Read the raw request body, refusing anything over `maxBytes` (413 `code`). */
export async function readBodyWithLimit(event: H3Event, maxBytes: number, code: string): Promise<Uint8Array<ArrayBuffer>> {
  const declared = getRequestHeader(event, 'content-length')
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw tooLarge(maxBytes, code)
  }
  const stream = getRequestWebStream(event)
  if (!stream) return new Uint8Array(0)
  const body = await readStreamWithCap(stream, maxBytes)
  if (!body) throw tooLarge(maxBytes, code)
  return body
}

/**
 * Parse an already size-bounded `multipart/form-data` body (WHATWG
 * parser via `Request#formData`). Returns null when the body is not
 * valid multipart for the request's Content-Type.
 */
export async function parseMultipart(event: H3Event, body: Uint8Array<ArrayBuffer>): Promise<FormData | null> {
  const contentType = getRequestHeader(event, 'content-type') ?? ''
  if (!/^multipart\/form-data/i.test(contentType)) return null
  try {
    return await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body }).formData()
  } catch {
    return null
  }
}
