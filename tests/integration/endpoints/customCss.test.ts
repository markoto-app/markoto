// Custom CSS for documents (`theme.customCss`).
//
// Write paths: every endpoint that stores a theme runs the shared
// sanitizer and answers 400 `theme/custom-css-invalid` with line/column
// issues — doc meta, saved themes (POST + PATCH), workspace default.
// Creating / duplicating a doc re-targets upload URLs.
//
// Render path: the server renderer applies the sanitized CSS (a
// distinctive page colour shows up in the PNG) and never fetches a URL
// the sanitizer dropped — even one on the renderer's own allowlist, and
// even when the CSS reached the DB without going through the write path
// (as a direct Y.js write would).
//
// Test stack: postgres-test + valkey-test + seaweedfs-test + renderer-test.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inflateSync } from 'node:zlib'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'

const FORBIDDEN = 'p { color: red }\n\n  @import "http://evil.test/x.css";'

interface IssueBody {
  data?: { code?: string, issues?: Array<{ code: string, line: number, column: number, message: string }> }
}

async function readDocTheme(docId: string): Promise<{ customCss?: string } | null> {
  const r = await testDb().query<{ theme: { customCss?: string } | null }>(
    'SELECT theme FROM documents WHERE doc_id = $1', [docId]
  )
  return r.rows[0]?.theme ?? null
}

async function setDocTheme(docId: string, theme: unknown): Promise<void> {
  await testDb().query('UPDATE documents SET theme = $2 WHERE doc_id = $1', [docId, JSON.stringify(theme)])
}

async function expectCustomCssRejected(res: Response, line: number, column: number, code: string) {
  expect(res.status).toBe(400)
  const body = await res.json() as IssueBody
  expect(body.data?.code).toBe('theme/custom-css-invalid')
  expect(body.data?.issues).toEqual([expect.objectContaining({ code, line, column })])
}

describe('custom CSS — write paths', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('PUT /meta stores valid custom CSS verbatim (formatting kept)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    const css = `/* mine */\n.paged-doc h1 {\n  color: #123456;\n}\np { background: url(/api/files/${doc.docId}/abc.png) }\n`
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: { ...defaultTheme, customCss: css } })
    expect(res.status).toBe(200)
    expect((await readDocTheme(doc.docId))?.customCss).toBe(css)
  })

  it('PUT /meta rejects a forbidden construct with its line/column and stores nothing', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: { ...defaultTheme, customCss: FORBIDDEN } })
    await expectCustomCssRejected(res, 3, 3, 'at-rule')
    expect(await readDocTheme(doc.docId)).toBeNull()
  })

  it('PUT /meta rejects another document\'s upload and external URLs', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    await expectCustomCssRejected(
      await client.put(`/api/docs/${doc.docId}/meta`, { theme: { ...defaultTheme, customCss: 'p { background: url(/api/files/someoneelse/a.png) }' } }),
      1, 17, 'other-doc-file'
    )
    await expectCustomCssRejected(
      await client.put(`/api/docs/${doc.docId}/meta`, { theme: { ...defaultTheme, customCss: 'p { background: url(https://evil.test/a.png) }' } }),
      1, 17, 'url'
    )
  })

  it('PUT /meta rejects custom CSS over 64 KB', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: { ...defaultTheme, customCss: 'x'.repeat(64 * 1024 + 1) } })
    expect(res.status).toBe(400)
  })

  it('POST + PATCH /api/themes validate custom CSS (any doc\'s upload path is fine there)', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    await expectCustomCssRejected(
      await client.post('/api/themes', { name: 'Bad', theme: { ...defaultTheme, customCss: FORBIDDEN } }),
      3, 3, 'at-rule'
    )
    const ok = await client.post('/api/themes', {
      name: 'Good',
      theme: { ...defaultTheme, customCss: 'p { background: url(/api/files/anydoc/a.png) }' }
    })
    expect(ok.status).toBe(200)
    const { themeId } = await ok.json() as { themeId: string }
    await expectCustomCssRejected(
      await client.patch(`/api/themes/${themeId}`, { theme: { ...defaultTheme, customCss: FORBIDDEN } }),
      3, 3, 'at-rule'
    )
  })

  it('PUT /api/workspaces/:id validates the default theme\'s custom CSS', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const client = await loggedInClient(admin.id)
    await expectCustomCssRejected(
      await client.put(`/api/workspaces/${ws.workspaceId}`, { defaultTheme: { ...defaultTheme, customCss: FORBIDDEN } }),
      3, 3, 'at-rule'
    )
    const ok = await client.put(`/api/workspaces/${ws.workspaceId}`, { defaultTheme: { ...defaultTheme, customCss: 'h1 { color: #123456 }' } })
    expect(ok.status).toBe(200)
  })

  it('POST /api/docs from a saved theme drops rules that point at another doc\'s uploads', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const created = await (await client.post('/api/themes', {
      name: 'With image',
      theme: { ...defaultTheme, customCss: 'h1 { color: #123456 }\np { background: url(/api/files/olddoc/a.png) }' }
    })).json() as { themeId: string }
    const res = await client.post('/api/docs', { themeId: created.themeId })
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    // The offending declaration is gone; the rule that held it stays (empty).
    expect((await readDocTheme(docId))?.customCss).toBe('h1{color:#123456}p{}')
  })

  it('POST /api/docs/:id/duplicate points custom CSS at the copy', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    await setDocTheme(doc.docId, { ...defaultTheme, customCss: `p { background: url(/api/files/${doc.docId}/a.png) }` })
    const client = await loggedInClient(owner.id)
    const res = await client.post(`/api/docs/${doc.docId}/duplicate`, {})
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    expect((await readDocTheme(docId))?.customCss).toBe(`p { background: url(/api/files/${docId}/a.png) }`)
  })
})

// Render path

// MUST match RENDERER_ALLOWED_ORIGINS on renderer-test in docker-compose.test.yml
// (shared with rendererNetwork.test.ts, which runs in the same process pool —
// vitest runs integration files serially, so the port is free here).
const ALLOWED_PORT = 3187

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

let canary: { server: Server, hits: string[] }

beforeAll(async () => {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1PX.length })
    res.end(PNG_1PX)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(ALLOWED_PORT, '0.0.0.0', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string' || (addr as AddressInfo).port !== ALLOWED_PORT) throw new Error('canary did not bind')
  canary = { server, hits }
})

afterAll(async () => {
  await new Promise<void>(r => canary.server.close(() => r()))
})

/** PNG row-filter predictor (filter types 0–4). */
function predictor(filter: number, a: number, b: number, c: number): number {
  if (filter === 0) return 0
  if (filter === 1) return a
  if (filter === 2) return b
  if (filter === 3) return Math.floor((a + b) / 2)
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Minimal PNG decoder (8-bit RGB / RGBA, non-interlaced) → RGB pixel at (x, y). */
function pixelAt(png: Buffer, x: number, y: number): [number, number, number] {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const len = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect(data[8]).toBe(8)
      colorType = data[9] ?? 0
      expect(data[12]).toBe(0)
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + len
  }
  const bpp = colorType === 6 ? 4 : 3
  expect([2, 6]).toContain(colorType)
  expect(x < width && y < height).toBe(true)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const prev = Buffer.alloc(stride)
  const cur = Buffer.alloc(stride)
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0
      const b = prev[i] ?? 0
      const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0
      const v = line[i] ?? 0
      cur[i] = (v + predictor(filter ?? 0, a, b, c)) & 0xff
    }
    cur.copy(prev)
  }
  const i = x * bpp
  return [prev[i] ?? 0, prev[i + 1] ?? 0, prev[i + 2] ?? 0]
}

async function insertYjsRow(docname: string, content: string): Promise<void> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, content)
  await testDb().query(
    `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2)`,
    [docname, Buffer.from(Y.encodeStateAsUpdate(ydoc))]
  )
}

interface ToolResponse {
  isError: boolean
  content: string
  extraParts: Array<{ inlineData?: { data?: string } }> | null
}

async function renderFirstPagePng(customCss: string): Promise<Buffer> {
  const owner = await createUser()
  const doc = await createDoc({ ownerId: owner.id })
  await insertYjsRow(doc.docId, '# Custom CSS\n\nA paragraph.\n')
  // Straight into the DB, bypassing PUT /meta — the same position a
  // direct Y.js write puts the renderer in.
  // No cover page, so page 1 is a body page whose sheet the CSS paints.
  await setDocTheme(doc.docId, { ...defaultTheme, cover: { ...defaultTheme.cover, enabled: false }, customCss })
  const client = await loggedInClient(owner.id)
  const res = await client.post('/api/_test/exec-ai-tool', { docId: doc.docId, name: 'view_pages', args: { pages: [1] } })
  expect(res.status).toBe(200)
  const body = await res.json() as ToolResponse
  expect(body.isError, body.content).toBe(false)
  const data = body.extraParts?.[0]?.inlineData?.data
  expect(data).toBeTruthy()
  return Buffer.from(data ?? '', 'base64')
}

describe('custom CSS — server renderer', () => {
  beforeEach(async () => {
    await resetDb()
    canary.hits.length = 0
  })

  it('applies the sanitized custom CSS (page colour visible in the PNG)', async () => {
    const png = await renderFirstPagePng('.pagedjs_page { background: #00ff00 !important }')
    // A corner pixel sits in the page margin: only the page sheet paints it.
    const [r, g, b] = pixelAt(png, 3, 3)
    expect(r).toBeLessThan(40)
    expect(g).toBeGreaterThan(215)
    expect(b).toBeLessThan(40)
  }, 90_000)

  it('without custom CSS the same pixel is the theme\'s page colour (control)', async () => {
    const png = await renderFirstPagePng('')
    const [, g, b] = pixelAt(png, 3, 3)
    expect(Math.abs(g - b)).toBeLessThan(40)
  }, 90_000)

  // A logo URL that breaks out of the cover `<img src>` attribute must not become a live event handler on
  // the render page. The marker handler would paint the page sheet green.
  it('a stored logo URL with an attribute breakout does not run on the render page', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    await insertYjsRow(doc.docId, '# Cover regression\n\nA paragraph.\n')
    const marker = `x" onerror="document.head.insertAdjacentHTML('beforeend','<style>.pagedjs_page{background:#00ff00!important}</style>')`
    await setDocTheme(doc.docId, {
      ...defaultTheme,
      cover: { ...defaultTheme.cover, enabled: true, showLogo: true },
      brand: { ...defaultTheme.brand, logoUrl: marker }
    })
    const client = await loggedInClient(owner.id)
    const res = await client.post('/api/_test/exec-ai-tool', { docId: doc.docId, name: 'view_pages', args: { pages: [1] } })
    expect(res.status).toBe(200)
    const body = await res.json() as ToolResponse
    expect(body.isError, body.content).toBe(false)
    const png = Buffer.from(body.extraParts?.[0]?.inlineData?.data ?? '', 'base64')
    const [, g, b] = pixelAt(png, 3, 3)
    expect(Math.abs(g - b)).toBeLessThan(40)
  }, 90_000)

  it('never fetches a url() the sanitizer dropped, even on the renderer allowlist', async () => {
    const png = await renderFirstPagePng(
      `.pagedjs_page { background: #00ff00 !important }\n.paged-doc { background-image: url(http://host.docker.internal:${ALLOWED_PORT}/from-custom-css.png) }\n:root { --x: url(http://host.docker.internal:${ALLOWED_PORT}/from-custom-prop.png) }\n.paged-doc h1 { background: var(--x) }`
    )
    // The rest of the CSS still applied…
    expect(pixelAt(png, 3, 3)[1]).toBeGreaterThan(215)
    // …but the canary (reachable + allowed) never saw a request.
    expect(canary.hits).toEqual([])
  }, 90_000)
})
