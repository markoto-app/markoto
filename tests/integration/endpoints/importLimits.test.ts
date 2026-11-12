// `/api/import` is public (anonymous document import). Regression cases
// for its resource limits:
//
//   - Request body: the server buffered the WHOLE body before any check
//     (the bun preset entry reads every body before routing; Bun's own cap
//     is 128 MB). The server entry (server/runtime/bunEntry.ts) now sets
//     Bun's maxRequestBodySize to 51 MiB: a declared Content-Length over it
//     is refused before anything is read, and a chunked body is cut off
//     once it passes it — the response arrives while the client is still
//     sending. (Bun answers these 413s itself, with an empty body.)
//   - Decompression: archive formats (DOCX/PPTX/XLSX/EPUB) went to
//     markitdown with no expansion cap; a ~300 KB DOCX that inflates to
//     300 MB OOM-killed a converter worker. markitdown now refuses it with
//     413 and keeps serving (tested against markitdown-test directly — the
//     integration app server has no markitdown configured). The ratio
//     check runs while inflating, so a bomb is refused after ~ratio x its
//     upload size of work, not after inflating up to the absolute cap.
//
// Test stack required: postgres-test + valkey-test + markitdown-test
// (deploy/compose/compose.test.yml).

import { describe, it, expect, beforeAll } from 'vitest'
import { request } from 'node:http'
import { Zip, ZipDeflate, zipSync, strToU8 } from 'fflate'
import { TEST_PORT } from '../setup/env'

const MARKITDOWN_URL = process.env.TEST_MARKITDOWN_URL ?? 'http://127.0.0.1:8081'
// MARKITDOWN_API_SECRET of markitdown-test (deploy/compose/compose.test.yml).
const MARKITDOWN_SECRET = 'test-markitdown-api-secret-isolated'
const BOUNDARY = '----markoto-import-limit-test'

interface Outcome {
  /** HTTP status, or 0 when the server closed the connection without one reaching us. */
  status: number
  body: string
  /** Had the client finished sending when the outcome (response or close) arrived? */
  endedFirst: boolean
  bytesSent: number
}

/**
 * POST /api/import, writing `chunks` of the multipart body one by one and
 * stopping as soon as a response arrives. `contentLength` = declared
 * length header (omitted → chunked transfer encoding). The request is
 * only ended after ALL chunks were written. A server that answers early
 * and closes the socket may surface to the client as EPIPE / ECONNRESET
 * instead of the response — that is reported as `status: 0`.
 */
function postImport(chunkCount: number, chunkBytes: number, contentLength?: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    let responded = false
    let ended = false
    let bytesSent = 0
    const headers: Record<string, string | number> = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` }
    if (contentLength !== undefined) headers['Content-Length'] = contentLength
    const req = request({ host: '127.0.0.1', port: TEST_PORT, path: '/api/import', method: 'POST', headers }, (res) => {
      responded = true
      const endedFirst = ended
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, endedFirst, bytesSent }))
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (responded) return
      responded = true
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
        resolve({ status: 0, body: '', endedFirst: ended, bytesSent })
        return
      }
      reject(err)
    })
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`)
    const chunk = Buffer.alloc(chunkBytes, 0x41)
    let sent = 0
    const pump = (): void => {
      if (responded) return
      if (sent === 0) {
        bytesSent += head.length
        req.write(head)
      }
      while (sent < chunkCount && !responded) {
        sent++
        bytesSent += chunk.length
        if (!req.write(chunk)) {
          req.once('drain', pump)
          return
        }
      }
      if (!responded && sent >= chunkCount) {
        ended = true
        req.end()
      }
    }
    pump()
  })
}

describe('request-body limit (server entry) on /api/import', () => {
  it('refuses a declared Content-Length over the cap without waiting for the body', async () => {
    // Declares 100 MB, sends only 1 KB and never ends: the endpoint must not wait for the rest of the body
    // (the test would time out).
    const out = await Promise.race([
      postImport(1, 1024, 100 * 1024 * 1024),
      new Promise<Outcome>((_, reject) => setTimeout(() => reject(new Error('no early response — body was being buffered')), 10_000))
    ])
    expect(out.status).toBe(413)
  }, 20_000)

  it('cuts a chunked upload off at the cap instead of buffering all of it', async () => {
    // 120 × 1 MiB, chunked (no Content-Length). The server must refuse while the client is still sending: Bun
    // answers 413 and closes the connection, which the client sees as the 413 or as the closed socket
    // depending on timing.
    const total = 120 * 1024 * 1024
    const out = await postImport(120, 1024 * 1024)
    expect(out.endedFirst).toBe(false)
    expect(out.bytesSent).toBeLessThan(total)
    expect([0, 413]).toContain(out.status)
  }, 60_000)
})

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
const DOC_OPEN = '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
const DOC_CLOSE = '</w:t></w:r></w:p></w:body></w:document>'

function smallDocx(text: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    'word/document.xml': strToU8(`${DOC_OPEN}${text}${DOC_CLOSE}`)
  })
}

/** A DOCX whose document.xml inflates to `megabytes` MiB (streamed, low memory). */
function bombDocx(megabytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = []
    const zip = new Zip((err, data, final) => {
      if (err) {
        reject(err)
        return
      }
      parts.push(data)
      if (final) resolve(Buffer.concat(parts))
    })
    for (const [name, text] of [['[Content_Types].xml', CONTENT_TYPES], ['_rels/.rels', RELS]] as const) {
      const entry = new ZipDeflate(name, { level: 9 })
      zip.add(entry)
      entry.push(strToU8(text), true)
    }
    const doc = new ZipDeflate('word/document.xml', { level: 9 })
    zip.add(doc)
    doc.push(strToU8(DOC_OPEN))
    const mib = new Uint8Array(1024 * 1024).fill(0x41)
    for (let i = 0; i < megabytes; i++) doc.push(mib)
    doc.push(strToU8(DOC_CLOSE), true)
    zip.end()
  })
}

async function convert(bytes: Uint8Array, ext: string): Promise<{ status: number, text: string }> {
  const res = await fetch(`${MARKITDOWN_URL}/convert?ext=${ext}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Markitdown-Secret': MARKITDOWN_SECRET },
    body: Buffer.from(bytes)
  })
  return { status: res.status, text: await res.text() }
}

describe('markitdown shared-secret auth', () => {
  it('refuses /convert and /design/extract without the secret, keeps /health open', async () => {
    const bare = { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(smallDocx('x')) }
    expect((await fetch(`${MARKITDOWN_URL}/convert?ext=docx`, bare)).status).toBe(401)
    expect((await fetch(`${MARKITDOWN_URL}/design/extract?ext=docx`, bare)).status).toBe(401)
    const wrong = { ...bare, headers: { ...bare.headers, 'X-Markitdown-Secret': 'wrong-secret' } }
    expect((await fetch(`${MARKITDOWN_URL}/convert?ext=docx`, wrong)).status).toBe(401)
    expect((await fetch(`${MARKITDOWN_URL}/health`)).status).toBe(200)
  })
})

describe('markitdown decompression limits', () => {
  // Building a bomb is CPU-bound and blocks this process's event loop for
  // seconds on a slow runner. Do it up front: done between requests it
  // would leave a pooled keep-alive connection idle past the server's
  // keep-alive timeout, and the next request would fail on that stale socket.
  let bomb300: Uint8Array
  let bomb150: Uint8Array
  beforeAll(async () => {
    bomb300 = await bombDocx(300)
    bomb150 = await bombDocx(150)
  }, 120_000)

  it('converts an ordinary DOCX (positive control)', async () => {
    const out = await convert(smallDocx('Hello from a small docx'), 'docx')
    expect(out.status).toBe(200)
    expect(out.text).toContain('Hello from a small docx')
  })

  it('regression: refuses a small DOCX that inflates to 300 MB, and keeps serving', async () => {
    expect(bomb300.byteLength).toBeLessThan(2 * 1024 * 1024)
    const out = await convert(bomb300, 'docx')
    expect(out.status).toBe(413)
    expect(out.text).toMatch(/archive/i)
    // Same worker pool still converts the next request.
    const after = await convert(smallDocx('still alive'), 'docx')
    expect(after.status).toBe(200)
    expect(after.text).toContain('still alive')
  }, 60_000)

  it('aborts a bomb that passes the declared-size check as soon as the ratio is exceeded', async () => {
    // 150 MiB declared (under the 200 MB cap) from a ~150 KB upload: only the
    // measured expansion can refuse it, and it must do so after about the
    // ratio allowance (100 x the upload, 10 MiB at least), not after
    // inflating all 150 MiB.
    expect(bomb150.byteLength).toBeLessThan(1024 * 1024)
    const allowance = Math.max(10 * 1024 * 1024, 100 * bomb150.byteLength)
    const out = await convert(bomb150, 'docx')
    expect(out.status).toBe(413)
    expect(out.text).toMatch(/compression ratio/)
    const inflated = Number(/stopped after (\d+) bytes/.exec(out.text)?.[1])
    expect(inflated).toBeGreaterThan(allowance)
    // Stops within one 64 KiB read chunk of the allowance.
    expect(inflated).toBeLessThanOrEqual(allowance + 64 * 1024)
  }, 60_000)

  it('refuses an archive with too many entries', async () => {
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      'word/document.xml': strToU8(`${DOC_OPEN}many${DOC_CLOSE}`)
    }
    for (let i = 0; i < 10_050; i++) files[`x/${i}`] = new Uint8Array(0)
    const out = await convert(zipSync(files, { level: 0 }), 'docx')
    expect(out.status).toBe(413)
    expect(out.text).toMatch(/entries/)
  }, 60_000)
})
