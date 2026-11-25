import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3'
import { useS3Client } from '../storage/s3'
import { apiError } from '../api/apiError'
import { useEnv } from '~~/shared/env/load'

/**
 * `Content-Disposition` of a served PDF. The plain `filename` keeps only
 * characters that are safe in any header parser; `filename*` (RFC 6266 /
 * 5987) carries the full title for browsers, so "Bericht über Zürich"
 * keeps its umlauts.
 */
export function pdfContentDisposition(title: string | null | undefined, inline: boolean): string {
  const name = (title ?? '').replace(/[\p{Cc}"\\/]/gu, '').trim().slice(0, 80) || 'document'
  const ascii = name.replace(/[^A-Za-z0-9 _.-]/g, '').trim() || 'document'
  const kind = inline ? 'inline' : 'attachment'
  const extended = encodeURIComponent(`${name}.pdf`).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}.pdf"; filename*=UTF-8''${extended}`
}

/**
 * Open a rendered PDF in the render cache as a stream (never buffered: a
 * long document can be tens of MB). A missing object is a failed render,
 * not a missing document.
 */
export async function openRenderedPdf(pdfKey: string): Promise<{ stream: ReadableStream, length: number | undefined }> {
  try {
    const res = await useS3Client().send(new GetObjectCommand({ Bucket: useEnv().storage.bucket, Key: pdfKey }))
    if (!res.Body) throw new NoSuchKey({ message: 'empty body', $metadata: {} })
    return { stream: res.Body.transformToWebStream(), length: res.ContentLength }
  } catch (e) {
    throw apiError('docs/render-failed', undefined, { cause: e })
  }
}
