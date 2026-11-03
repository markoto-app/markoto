// Integration tests for GET /api/docs/:docId/pdf — the user-facing PDF
// download endpoint that hits the REAL Playwright renderer container,
// drives the print page through paged.js, captures bytes, caches in S3,
// and 302s to a presigned URL.
//
// Why real (no stub): the previous stub recorded HTTP calls and uploaded
// canned bytes, but couldn't catch:
//   - SSR-layer bugs in the print page (zod imports wedging Vite SSR)
//   - browser-layer bugs (paged.js choking on Nuxt UI's oklch() values)
// The stub-based tests were really HTTP-contract tests; this file is a
// genuine integration test of the renderer + Nuxt + paged.js + S3 chain.
//
// Test stack required: postgres-test + valkey-test + seaweedfs-test +
// renderer-test (all in docker-compose.test.yml). `bun run test:integration:up`
// brings them up.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb, ensureYjsTable } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { defaultTheme } from '../../../shared/utils/defaultTheme'
import { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

// Insert a Y.Doc row with REAL bytes. The renderer replays this back into
// markdown — empty docs paginate to zero pages and the renderer surfaces
// an error, so test fixtures must contain at least a few non-empty lines.
async function insertYjsRow(docname: string, content: string): Promise<number> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, content)
  const update = Y.encodeStateAsUpdate(ydoc)
  const db = testDb()
  const r = await db.query<{ id: number }>(
    `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1') RETURNING id`,
    [docname, Buffer.from(update)]
  )
  return r.rows[0].id
}

// Multi-page fixture body — paginates to ≥3 pages on the default theme.
// Used in tests that care about real PDF output. Heavy enough that the
// renderer takes meaningful time (~1-2s); thin enough that tests don't
// run for hours.
function multiPageBody(): string {
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.'
  const sections = ['Introduction', 'Background', 'Methodology', 'Results', 'Discussion']
  const parts = ['# Test fixture\n\n']
  for (const s of sections) {
    parts.push(`## ${s}\n\n${para}\n\n${para}\n\n- bullet a\n- bullet b\n- bullet c\n\n`)
  }
  return parts.join('')
}

const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:8334',
  region: 'us-east-1',
  credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
  forcePathStyle: true
})

async function wipeRendersFor(docId: string): Promise<void> {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: 'ypad', Prefix: `renders/${docId}/` }))
  const keys = (list.Contents || []).map(o => ({ Key: o.Key! })).filter(k => k.Key)
  if (keys.length === 0) return
  await s3.send(new DeleteObjectsCommand({ Bucket: 'ypad', Delete: { Objects: keys, Quiet: true } }))
}

async function listRenderKeys(docId: string): Promise<string[]> {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: 'ypad', Prefix: `renders/${docId}/` }))
  return (list.Contents || []).map(o => o.Key!).filter(Boolean)
}

async function fetchRenderBytes(key: string): Promise<Uint8Array> {
  const got = await s3.send(new GetObjectCommand({ Bucket: 'ypad', Key: key }))
  return await got.Body!.transformToByteArray()
}

beforeEach(async () => {
  await resetDb()
  await ensureYjsTable()
})

// Pay the render chain's COLD-START cost before any measured test. The
// first render after stack boot covers Chromium's first page load in the
// renderer container + the print page's SSR warm-up; on a loaded 2-core
// CI runner that cold path has taken long enough that the app server
// killed the connection mid-request ("TypeError: fetch failed /
// SocketError: other side closed"), failing whichever auth-matrix test
// ran first and cascading into the next request (observed twice on
// 2026-08-18 across unrelated PRs; never locally, where cold renders
// finish in ~2s). One tolerated warm-up render moves that cost out of
// the measured tests; every test below still asserts exactly what it
// asserted before. Deliberately non-fatal: if the renderer is genuinely
// broken, the real tests fail with far better errors than this hook
// could produce.
beforeAll(async () => {
  await resetDb()
  await ensureYjsTable()
  const owner = await createUser()
  const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
  await insertYjsRow(doc.docId, '# warmup\n\ncold-start render\n')
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      if (res.status === 302) {
        console.info(`[docPdf] warm-up render ok (attempt ${attempt})`)
        return
      }
      console.warn(`[docPdf] warm-up render got ${res.status} (attempt ${attempt})`)
    } catch (e) {
      console.warn(`[docPdf] warm-up render failed (attempt ${attempt}):`, e instanceof Error ? e.message : e)
    }
  }
}, 120_000)

describe('GET /api/docs/:docId/pdf — real renderer', () => {
  describe('not-found and basic shape', () => {
    it('returns 404 for a nonexistent doc', async () => {
      const res = await anonClient().get('/api/docs/nonexistent/pdf')
      expect(res.status).toBe(404)
    })
  })

  describe('auth matrix (gates BEFORE rendering)', () => {
    // For these tests, we don't actually need to render — the gate
    // fires first. Use minimal content so if a regression sneaks the
    // call through, the rendering failure is clean.
    const SHORT = '# hello\n\nworld\n'

    it('anonymous gets 302 on open-edit', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      await insertYjsRow(doc.docId, SHORT)

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)

      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      expect(location).toContain(`renders/${doc.docId}/`)
      expect(location).toContain('document.pdf')
      expect(location).toMatch(/response-content-disposition=attachment/i)
      // Neither the redirect nor the PDF bytes may land in a shared cache.
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(location).toMatch(/response-cache-control=private%2C%20no-store/i)

      await wipeRendersFor(doc.docId)
    }, 60_000)

    it('anonymous is denied on private', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      await insertYjsRow(doc.docId, SHORT)

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(403)
      // No render artefacts should land for a denied request.
      const keys = await listRenderKeys(doc.docId)
      expect(keys).toHaveLength(0)
    })

    it('logged-in non-owner is denied on private', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      await insertYjsRow(doc.docId, SHORT)
      const client = await loggedInClient(other.id)

      const res = await client.get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(403)
    })

    it('owner gets 302 on private', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      await insertYjsRow(doc.docId, SHORT)
      const client = await loggedInClient(owner.id)

      const res = await client.get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      await wipeRendersFor(doc.docId)
    }, 60_000)

    it('workspace viewer gets 302 on private workspace doc', async () => {
      const admin = await createUser()
      const viewer = await createUser()
      const ws = await createWorkspace(admin.id)
      await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
      const doc = await createDoc({
        ownerId: admin.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      await insertYjsRow(doc.docId, SHORT)

      const client = await loggedInClient(viewer.id)
      const res = await client.get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      await wipeRendersFor(doc.docId)
    }, 60_000)
  })

  describe('end-to-end PDF render', () => {
    it('produces a valid multi-page PDF that round-trips through S3', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const snapId = await insertYjsRow(doc.docId, multiPageBody())

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)

      // S3 has a real PDF at the snapshot-keyed path.
      const pdfKey = `renders/${doc.docId}/${snapId}/document.pdf`
      const head = await s3.send(new HeadObjectCommand({ Bucket: 'ypad', Key: pdfKey }))
      expect(head.ContentLength).toBeGreaterThan(1000) // multi-page PDF is well over 1KB

      const bytes = await fetchRenderBytes(pdfKey)
      // PDF magic: %PDF-
      expect(bytes[0]).toBe(0x25)
      expect(bytes[1]).toBe(0x50)
      expect(bytes[2]).toBe(0x44)
      expect(bytes[3]).toBe(0x46)
      expect(bytes[4]).toBe(0x2D)

      // Manifest exists too — the renderer writes it last as the
      // readiness sentinel for cache-hit lookups.
      const manifestKey = `renders/${doc.docId}/${snapId}/manifest.json`
      const manifestBytes = await fetchRenderBytes(manifestKey)
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
        snapshotId: number
        pageCount: number
        format: string
        pdfKey: string | null
      }
      expect(manifest.snapshotId).toBe(snapId)
      expect(manifest.pageCount).toBeGreaterThanOrEqual(2) // multi-page fixture
      expect(manifest.format).toBe('pdf')
      expect(manifest.pdfKey).toBe(pdfKey)

      await wipeRendersFor(doc.docId)
    }, 90_000)

    // Fonts, KaTeX and highlight.js come from the app's own /vendor/ path
    // (the renderer allows no CDN host any more). Chromium embeds the font
    // files it actually used, by name: had a web font failed to load, the
    // PDF would carry a system fallback instead.
    it('embeds the theme\'s self-hosted fonts and KaTeX\'s math font', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const theme = {
        ...defaultTheme,
        body: { ...defaultTheme.body, font: 'Lora' },
        headings: { ...defaultTheme.headings, font: 'Playfair Display' },
        meta: { ...defaultTheme.meta, font: 'IBM Plex Mono' }
      }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const snapId = await insertYjsRow(doc.docId, '# Fonts and math\n\nBody text in Lora, *in italics too*.\n\n$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$\n\n```js\nconst answer = 42\n```\n')

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      const fontNames = [...pdf.matchAll(/\/BaseFont\s*\/([\w+-]+)/g)].map(m => m[1] ?? '')
      expect(fontNames.some(n => /Lora/i.test(n)), fontNames.join(', ')).toBe(true)
      expect(fontNames.some(n => /Playfair/i.test(n)), fontNames.join(', ')).toBe(true)
      expect(fontNames.some(n => /KaTeX/i.test(n)), fontNames.join(', ')).toBe(true)

      await wipeRendersFor(doc.docId)
    }, 90_000)

    it('cache hit: second call reuses the manifest and produces no new artefacts', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      await insertYjsRow(doc.docId, multiPageBody())

      // Warm.
      const first = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(first.status).toBe(302)
      const beforeKeys = (await listRenderKeys(doc.docId)).sort()
      expect(beforeKeys.length).toBeGreaterThan(0)

      // Second call should hit the cache: same key set, no new objects.
      const second = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(second.status).toBe(302)
      expect(second.headers.get('location')).toContain('document.pdf')

      const afterKeys = (await listRenderKeys(doc.docId)).sort()
      expect(afterKeys).toEqual(beforeKeys)

      await wipeRendersFor(doc.docId)
    }, 90_000)
  })

  describe('Content-Disposition filename', () => {
    it('uses the doc title sanitized', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'open-edit',
        title: 'My Quarterly Report 2026'
      })
      await insertYjsRow(doc.docId, '# Quarterly\n\nbody.\n')

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const location = res.headers.get('location')!
      expect(decodeURIComponent(location)).toContain('My Quarterly Report 2026.pdf')

      await wipeRendersFor(doc.docId)
    }, 60_000)

    it('strips characters problematic for HTTP headers from the title', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'open-edit',
        title: 'Bad/Title:With"Specials\\?<>'
      })
      await insertYjsRow(doc.docId, '# x\n\nbody.\n')

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const decoded = decodeURIComponent(res.headers.get('location')!)
      expect(decoded).not.toMatch(/filename="[^"]*[/:"\\?<>][^"]*"/)
      expect(decoded).toMatch(/filename="[^"]+\.pdf"/)

      await wipeRendersFor(doc.docId)
    }, 60_000)
  })

  describe('snapshot keying', () => {
    it('a new yjs row produces a fresh render at a different key', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const snap1 = await insertYjsRow(doc.docId, '# v1\n\nfirst version.\n')

      const r1 = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(r1.status).toBe(302)
      expect(r1.headers.get('location')).toContain(`renders/${doc.docId}/${snap1}/`)

      const snap2 = await insertYjsRow(doc.docId, '# v2\n\nsecond version with extra content.\n')
      expect(snap2).toBeGreaterThan(snap1)

      const r2 = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(r2.status).toBe(302)
      expect(r2.headers.get('location')).toContain(`renders/${doc.docId}/${snap2}/`)

      // Both renders persisted independently.
      const keys = await listRenderKeys(doc.docId)
      expect(keys.some(k => k.includes(`/${snap1}/`))).toBe(true)
      expect(keys.some(k => k.includes(`/${snap2}/`))).toBe(true)

      await wipeRendersFor(doc.docId)
    }, 120_000)
  })

  describe('cleanup on doc delete', () => {
    it('deleting a doc wipes its renders/ prefix from S3', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      await insertYjsRow(doc.docId, '# hello\n\nworld.\n')

      const client = await loggedInClient(owner.id)
      const r = await client.get(`/api/docs/${doc.docId}/pdf`)
      expect(r.status).toBe(302)

      const beforeDel = await listRenderKeys(doc.docId)
      expect(beforeDel.length).toBeGreaterThan(0)

      const delRes = await client.delete(`/api/docs/${doc.docId}`)
      expect(delRes.ok).toBe(true)
      // cleanupRendersForDoc runs sequentially in deleteDocument; small
      // delay covers any S3 propagation lag on SeaweedFS.
      await new Promise(r => setTimeout(r, 200))

      const afterDel = await listRenderKeys(doc.docId)
      expect(afterDel).toHaveLength(0)
    }, 60_000)
  })
})
