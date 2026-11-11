import type { H3Event } from 'h3'
import { customAlphabet } from 'nanoid'
import { readBodyWithLimit, parseMultipart } from '../platform/requestBodyLimit'

// Shared request handling for brand-kit uploads (WP10): one multipart
// POST, read whole (≤ the per-file cap + form overhead) and checked in
// memory — the bytes that are inspected are exactly the bytes stored.

const FORM_OVERHEAD = 64 * 1024

/** 16 chars from the URL-safe alphabet (the `/api/brand/<id>` shape). */
export const newBrandAssetId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 16)

export async function readBrandUpload(event: H3Event, maxBytes: number): Promise<{ bytes: Uint8Array, fileName: string, form: FormData }> {
  if (!(await checkRateLimit('brand-upload', `${requireWsId(event)}`, 60, 60 * 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many uploads. Try again later.', data: { code: 'brand/rate-limited' } })
  }
  const body = await readBodyWithLimit(event, maxBytes + FORM_OVERHEAD, 'brand/file-too-large')
  const form = await parseMultipart(event, body)
  const file = form?.get('file')
  if (!form || !file || typeof file === 'string') {
    throw createError({ statusCode: 400, message: 'Send the file as multipart form field "file".', data: { code: 'brand/file-missing' } })
  }
  if (file.size > maxBytes) {
    throw createError({ statusCode: 413, message: `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`, data: { code: 'brand/file-too-large' } })
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name || '', form }
}
