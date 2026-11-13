import type { H3Event } from 'h3'
import { customAlphabet } from 'nanoid'
import { readBodyWithLimit, parseMultipart } from '../platform/requestBodyLimit'
import { apiError } from '../api/apiError'

// Shared request handling for brand-kit uploads: one multipart
// POST, read whole (≤ the per-file cap + form overhead) and checked in
// memory: the bytes that are inspected are exactly the bytes stored.

const FORM_OVERHEAD = 64 * 1024

/** 16 chars from the URL-safe alphabet (the `/api/brand/<id>` shape). */
export const newBrandAssetId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 16)

export async function readBrandUpload(event: H3Event, maxBytes: number): Promise<{ bytes: Uint8Array, fileName: string, form: FormData }> {
  const body = await readBodyWithLimit(event, maxBytes + FORM_OVERHEAD, 'brand/file-too-large')
  const form = await parseMultipart(event, body)
  const file = form?.get('file')
  if (!form || !file || typeof file === 'string') {
    throw apiError('brand/file-missing')
  }
  if (file.size > maxBytes) {
    throw apiError('brand/file-too-large')
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name || '', form }
}
