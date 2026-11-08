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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb, ensureYjsTable } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { defaultTheme } from '../../../shared/utils/defaultTheme'
import { THEME_PRESETS } from '../../../shared/utils/themePresets'
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

    it('?response=json answers the same presigned URL as JSON (no redirect, no-store)', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      await insertYjsRow(doc.docId, SHORT)

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf?response=json`)

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      const { url } = await res.json() as { url: string }
      expect(url).toContain(`renders/${doc.docId}/`)
      expect(url).toMatch(/response-content-disposition=attachment/i)

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

    // Multi-column theme + cover PAGE: the cover spans both columns
    // (column-span, themeToCss coverBlock) and the body still follows it.
    // The IEEE conference preset itself uses the title block (no cover
    // page), so the cover-page layout is set explicitly.
    it('two-column theme with a cover still renders the body after the cover', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const ieee = THEME_PRESETS.find(p => p.id === 'ieee-conference')!.theme
      expect(ieee.layout.columns).toBe(2)
      const theme = { ...ieee, cover: { ...ieee.cover, enabled: true, layout: 'editorial' } }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const snapId = await insertYjsRow(doc.docId, multiPageBody())

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const manifest = JSON.parse(new TextDecoder().decode(
        await fetchRenderBytes(`renders/${doc.docId}/${snapId}/manifest.json`)
      )) as { pageCount: number }
      expect(manifest.pageCount).toBeGreaterThanOrEqual(2)
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      const fontNames = [...pdf.matchAll(/\/(?:BaseFont|FontName)\s*\/([\w+-]+)/g)].map(m => m[1] ?? '')
      // The body face only appears when body text was laid out.
      const bodyFont = ieee.body.font.replaceAll(' ', '')
      expect(fontNames.some(n => n.replaceAll('-', '').includes(bodyFont)), fontNames.join(', ')).toBe(true)

      await wipeRendersFor(doc.docId)
    }, 90_000)

    // Title block (papers): no cover page — title, authors and the leading
    // "Abstract" section open page 1 and the two-column body follows on the
    // same page and continues after it.
    it('two-column title block renders title, abstract and the whole body', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const ieee = THEME_PRESETS.find(p => p.id === 'ieee-conference')!.theme
      expect(ieee.cover.layout).toBe('title-block')
      const theme = { ...ieee, cover: { ...ieee.cover, authors: ['Ada Kovač'], affiliations: ['University of Zurich'] } }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const abstract = '## Abstract\n\nWe measure stale reads under partitions.\n\n'
      const snapId = await insertYjsRow(doc.docId, abstract + multiPageBody() + multiPageBody().replace('# Test fixture', '# Second part'))

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const manifest = JSON.parse(new TextDecoder().decode(
        await fetchRenderBytes(`renders/${doc.docId}/${snapId}/manifest.json`)
      )) as { pageCount: number }
      expect(manifest.pageCount).toBeGreaterThanOrEqual(2)
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      const fontNames = [...pdf.matchAll(/\/(?:BaseFont|FontName)\s*\/([\w+-]+)/g)].map(m => m[1] ?? '')
      const bodyFont = ieee.body.font.replaceAll(' ', '')
      expect(fontNames.some(n => n.replaceAll('-', '').includes(bodyFont)), fontNames.join(', ')).toBe(true)

      await wipeRendersFor(doc.docId)
    }, 90_000)

    // The bundled TeX fonts (fonts/<slug>/, GUST licence) load from
    // /vendor/fonts/ like the Fontsource families and embed as real
    // TrueType fonts — CFF outlines would be embedded as Type 3 glyph
    // procedures by Chromium (scripts/build-bundled-fonts.py converts them).
    it('embeds the bundled TeX Gyre Termes and Latin Modern Mono as TrueType fonts', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const theme = {
        ...defaultTheme,
        body: { ...defaultTheme.body, font: 'TeX Gyre Termes' },
        code: { ...defaultTheme.code, font: 'Latin Modern Mono' }
      }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const snapId = await insertYjsRow(doc.docId, '# Fonts\n\nBody text in Termes, **bold too**.\n\n```js\nconst answer = 42\n```\n')

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      // Each font dictionary: its /Subtype and /BaseFont.
      const fonts = [...pdf.matchAll(/\/Subtype\s*\/(\w+)[^>]*?\/BaseFont\s*\/([\w+-]+)|\/BaseFont\s*\/([\w+-]+)[^>]*?\/Subtype\s*\/(\w+)/g)]
        .map(m => ({ subtype: m[1] ?? m[4] ?? '', name: m[2] ?? m[3] ?? '' }))
      const summary = fonts.map(f => `${f.name}:${f.subtype}`).join(', ')
      const termes = fonts.filter(f => /TeXGyreTermes/.test(f.name))
      const lmMono = fonts.filter(f => /LMMono/.test(f.name))
      expect(termes.length, summary).toBeGreaterThan(0)
      expect(lmMono.length, summary).toBeGreaterThan(0)
      for (const f of [...termes, ...lmMono]) expect(f.subtype, summary).not.toBe('Type3')

      await wipeRendersFor(doc.docId)
    }, 90_000)

    // The arXiv preprint preset end to end: Letter pages, title block,
    // running head with its rule, the preset's template CSS (sanitised at
    // render like any custom CSS) and the bundled Termes / Latin Modern
    // Mono — embedded as TrueType, never as Type 3 glyph procedures.
    it('renders the arXiv preprint fixture over several pages with Termes embedded as TrueType', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')?.theme
      if (!arxiv) throw new Error('arxiv preset missing')
      expect(arxiv.customCss).toBeTruthy()
      const theme = { ...arxiv, cover: { ...arxiv.cover, authors: ['David S. Hippocampus', 'Elias D. Striatum'], affiliations: ['Cranberry-Lemon University', 'Mount-Sheikh University'] } }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const fixture = readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/arxiv.md', import.meta.url))), 'utf8')
      const snapId = await insertYjsRow(doc.docId, fixture)

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const manifest: unknown = JSON.parse(new TextDecoder().decode(
        await fetchRenderBytes(`renders/${doc.docId}/${snapId}/manifest.json`)
      ))
      const pageCount = typeof manifest === 'object' && manifest !== null && 'pageCount' in manifest ? manifest.pageCount : null
      expect(typeof pageCount).toBe('number')
      expect(Number(pageCount)).toBeGreaterThanOrEqual(2)
      expect(Number(pageCount)).toBeLessThanOrEqual(4)
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      // US Letter: 612 × 792 pt.
      expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+612(?:\.0+)?\s+792(?:\.0+)?\s*\]/)
      const fonts = [...pdf.matchAll(/\/Subtype\s*\/(\w+)[^>]*?\/BaseFont\s*\/([\w+-]+)|\/BaseFont\s*\/([\w+-]+)[^>]*?\/Subtype\s*\/(\w+)/g)]
        .map(m => ({ subtype: m[1] ?? m[4] ?? '', name: m[2] ?? m[3] ?? '' }))
      const summary = fonts.map(f => `${f.name}:${f.subtype}`).join(', ')
      const termes = fonts.filter(f => /TeXGyreTermes/.test(f.name))
      expect(termes.length, summary).toBeGreaterThan(0)
      // Regular, bold (sections) and italic (references) faces all used.
      expect(new Set(termes.map(f => f.name.replace(/^[A-Z]{6}\+/, ''))).size, summary).toBeGreaterThanOrEqual(3)
      for (const f of fonts) expect(f.subtype, summary).not.toBe('Type3')

      await wipeRendersFor(doc.docId)
    }, 90_000)

    // The business-report preset end to end: cover page, contents on a page
    // of their own, KPI tables, Mermaid pie + xychart and the template CSS.
    async function renderBusinessReport(): Promise<{ pdf: string, pageCount: unknown, docId: string }> {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const preset = THEME_PRESETS.find(p => p.id === 'business-report')?.theme
      if (!preset) throw new Error('business-report preset missing')
      expect(preset.customCss).toBeTruthy()
      const theme = { ...preset, cover: { ...preset.cover, subtitle: 'Quarterly report for the period 1 July to 30 September 2026', authors: ['Halden Outdoor AG, Frauenfeld'], date: '2026-11-05' } }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const fixture = readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/business-report.md', import.meta.url))), 'utf8')
      const snapId = await insertYjsRow(doc.docId, fixture)
      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const manifest: unknown = JSON.parse(new TextDecoder().decode(
        await fetchRenderBytes(`renders/${doc.docId}/${snapId}/manifest.json`)
      ))
      const pageCount = typeof manifest === 'object' && manifest !== null && 'pageCount' in manifest ? manifest.pageCount : null
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      return { pdf, pageCount, docId: doc.docId }
    }

    it('renders the business-report fixture as an A4 report of 6–8 pages', async () => {
      const { pdf, pageCount, docId } = await renderBusinessReport()
      expect(typeof pageCount).toBe('number')
      // Preview: 7 pages (cover, contents, five of report).
      expect(Number(pageCount)).toBeGreaterThanOrEqual(6)
      expect(Number(pageCount)).toBeLessThanOrEqual(8)
      // A4 (210 × 297 mm ≈ 595 × 842 pt; Chromium rounds to its own grid).
      expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+59[45](?:\.\d+)?\s+84[12](?:\.\d+)?\s*\]/)
      await wipeRendersFor(docId)
    }, 90_000)

    // Inter and Source Serif 4 used to come from Fontsource VARIABLE fonts,
    // which Chromium embeds as Type 3 (no BaseFont name). Documents now get
    // the static cuts (themeFonts.ts): both embed as real (TrueType/CID)
    // fonts, and no Type 3 font is left in the file.
    it('embeds Inter and Source Serif 4 as real fonts, never Type 3', async () => {
      const { pdf, docId } = await renderBusinessReport()
      const fonts = [...pdf.matchAll(/\/Subtype\s*\/(\w+)[^>]*?\/BaseFont\s*\/([\w+-]+)|\/BaseFont\s*\/([\w+-]+)[^>]*?\/Subtype\s*\/(\w+)/g)]
        .map(m => ({ subtype: m[1] ?? m[4] ?? '', name: m[2] ?? m[3] ?? '' }))
      const summary = fonts.map(f => `${f.name}:${f.subtype}`).join(', ')
      await wipeRendersFor(docId)
      expect(fonts.some(f => /Inter/.test(f.name)), summary).toBe(true)
      expect(fonts.some(f => /SourceSerif4/.test(f.name)), summary).toBe(true)
      for (const f of fonts) expect(f.subtype, summary).not.toBe('Type3')
      // A Type 3 font has no /BaseFont, so the list above can't show it.
      expect(pdf, summary).not.toMatch(/\/Subtype\s*\/Type3/)
    }, 90_000)

    // The technical-documentation preset end to end: title block + TOC on
    // page 1 and the template CSS (hanging section numbers, full-width code)
    // sanitised at render.
    async function renderTechDocs(): Promise<{ pdf: string, pageCount: unknown, docId: string }> {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const preset = THEME_PRESETS.find(p => p.id === 'tech-docs')?.theme
      if (!preset) throw new Error('tech-docs preset missing')
      expect(preset.customCss).toBeTruthy()
      const theme = { ...preset, cover: { ...preset.cover, subtitle: 'Durable background jobs on PostgreSQL — version 3.4', authors: ['The Ferrule maintainers'], date: '2026-11-04' } }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const fixture = readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/tech-docs.md', import.meta.url))), 'utf8')
      const snapId = await insertYjsRow(doc.docId, fixture)
      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const manifest: unknown = JSON.parse(new TextDecoder().decode(
        await fetchRenderBytes(`renders/${doc.docId}/${snapId}/manifest.json`)
      ))
      const pageCount = typeof manifest === 'object' && manifest !== null && 'pageCount' in manifest ? manifest.pageCount : null
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      return { pdf, pageCount, docId: doc.docId }
    }

    it('renders the tech-docs fixture in the tech-docs preset on 8–11 pages', async () => {
      const { pageCount, docId } = await renderTechDocs()
      expect(typeof pageCount).toBe('number')
      // 10 pages in the preview (markoto: 14).
      expect(Number(pageCount)).toBeGreaterThanOrEqual(8)
      expect(Number(pageCount)).toBeLessThanOrEqual(11)
      await wipeRendersFor(docId)
    }, 90_000)

    // Source Serif 4 and Source Sans 3 used to be Fontsource VARIABLE fonts,
    // which Chromium embeds as Type 3 (no BaseFont name). With the static
    // cuts all three families embed as real (TrueType/CID) fonts.
    it('embeds Source Serif 4, Source Sans 3 and IBM Plex Mono as real fonts, never Type 3', async () => {
      const { pdf, docId } = await renderTechDocs()
      const fonts = [...pdf.matchAll(/\/Subtype\s*\/(\w+)[^>]*?\/BaseFont\s*\/([\w+-]+)|\/BaseFont\s*\/([\w+-]+)[^>]*?\/Subtype\s*\/(\w+)/g)]
        .map(m => ({ subtype: m[1] ?? m[4] ?? '', name: m[2] ?? m[3] ?? '' }))
      const summary = fonts.map(f => `${f.name}:${f.subtype}`).join(', ')
      await wipeRendersFor(docId)
      for (const family of [/SourceSerif/i, /SourceSans/i, /IBMPlexMono/i]) {
        expect(fonts.some(f => family.test(f.name)), summary).toBe(true)
      }
      for (const f of fonts) expect(f.subtype, summary).not.toBe('Type3')
      // A Type 3 font has no /BaseFont, so the list above can't show it.
      expect(pdf, summary).not.toMatch(/\/Subtype\s*\/Type3/)
    }, 90_000)

    // The design-doc preset end to end: title block over the metadata
    // header, the template CSS (prose column, decision records, comparison
    // tables) sanitised at render, two Mermaid diagrams, and IBM Plex Sans /
    // Mono embedded as real fonts, never Type 3.
    it('renders the design-doc fixture as an A4 RFC of 6–8 pages with IBM Plex embedded as real fonts', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const preset = THEME_PRESETS.find(p => p.id === 'design-doc')?.theme
      if (!preset) throw new Error('design-doc preset missing')
      expect(preset.customCss).toBeTruthy()
      const patch: unknown = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/design-doc-patch.json', import.meta.url))), 'utf8'))
      const cover = typeof patch === 'object' && patch !== null && 'cover' in patch && typeof patch.cover === 'object' && patch.cover !== null ? patch.cover : {}
      const theme = { ...preset, cover: { ...preset.cover, ...cover } }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const fixture = readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/design-doc.md', import.meta.url))), 'utf8')
      const snapId = await insertYjsRow(doc.docId, fixture)
      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const manifest: unknown = JSON.parse(new TextDecoder().decode(
        await fetchRenderBytes(`renders/${doc.docId}/${snapId}/manifest.json`)
      ))
      const pageCount = typeof manifest === 'object' && manifest !== null && 'pageCount' in manifest ? manifest.pageCount : null
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      await wipeRendersFor(doc.docId)
      // 7 pages in the preview.
      expect(typeof pageCount).toBe('number')
      expect(Number(pageCount)).toBeGreaterThanOrEqual(6)
      expect(Number(pageCount)).toBeLessThanOrEqual(8)
      // A4 (210 × 297 mm ≈ 595 × 842 pt; Chromium rounds to its own grid).
      expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+59[45](?:\.\d+)?\s+84[12](?:\.\d+)?\s*\]/)
      const fonts = [...pdf.matchAll(/\/Subtype\s*\/(\w+)[^>]*?\/BaseFont\s*\/([\w+-]+)|\/BaseFont\s*\/([\w+-]+)[^>]*?\/Subtype\s*\/(\w+)/g)]
        .map(m => ({ subtype: m[1] ?? m[4] ?? '', name: m[2] ?? m[3] ?? '' }))
      const summary = fonts.map(f => `${f.name}:${f.subtype}`).join(', ')
      for (const family of [/IBMPlexSans/i, /IBMPlexMono/i]) {
        expect(fonts.some(f => family.test(f.name)), summary).toBe(true)
      }
      for (const f of fonts) expect(f.subtype, summary).not.toBe('Type3')
      // A Type 3 font has no /BaseFont, so the list above can't show it.
      expect(pdf, summary).not.toMatch(/\/Subtype\s*\/Type3/)
    }, 90_000)

    // The IEEE conference preset end to end: Letter pages, two columns,
    // title block with three author blocks, the template CSS and the
    // bundled Termes (regular, bold abstract, italic subsections) embedded
    // as TrueType, never as Type 3 glyph procedures.
    it('renders the IEEE conference fixture on Letter pages with Termes embedded as TrueType', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const ieee = THEME_PRESETS.find(p => p.id === 'ieee-conference')?.theme
      if (!ieee) throw new Error('ieee-conference preset missing')
      expect(ieee.customCss).toBeTruthy()
      const patch: unknown = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/ieee-conference-patch.json', import.meta.url))), 'utf8'))
      const cover = typeof patch === 'object' && patch !== null && 'cover' in patch && typeof patch.cover === 'object' && patch.cover !== null ? patch.cover : {}
      const theme = { ...ieee, cover: { ...ieee.cover, ...cover } }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const fixture = readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/ieee-conference.md', import.meta.url))), 'utf8')
      const snapId = await insertYjsRow(doc.docId, fixture)

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const manifest: unknown = JSON.parse(new TextDecoder().decode(
        await fetchRenderBytes(`renders/${doc.docId}/${snapId}/manifest.json`)
      ))
      const pageCount = typeof manifest === 'object' && manifest !== null && 'pageCount' in manifest ? manifest.pageCount : null
      expect(typeof pageCount).toBe('number')
      expect(Number(pageCount)).toBeGreaterThanOrEqual(1)
      expect(Number(pageCount)).toBeLessThanOrEqual(2)
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      // US Letter: 612 × 792 pt.
      expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+612(?:\.0+)?\s+792(?:\.0+)?\s*\]/)
      const fonts = [...pdf.matchAll(/\/Subtype\s*\/(\w+)[^>]*?\/BaseFont\s*\/([\w+-]+)|\/BaseFont\s*\/([\w+-]+)[^>]*?\/Subtype\s*\/(\w+)/g)]
        .map(m => ({ subtype: m[1] ?? m[4] ?? '', name: m[2] ?? m[3] ?? '' }))
      const summary = fonts.map(f => `${f.name}:${f.subtype}`).join(', ')
      const termes = fonts.filter(f => /TeXGyreTermes/.test(f.name))
      expect(termes.length, summary).toBeGreaterThan(0)
      expect(new Set(termes.map(f => f.name.replace(/^[A-Z]{6}\+/, ''))).size, summary).toBeGreaterThanOrEqual(3)
      for (const f of fonts) expect(f.subtype, summary).not.toBe('Type3')

      await wipeRendersFor(doc.docId)
    }, 90_000)

    // The thesis preset end to end: a title page, the chapter on a new page
    // (template CSS `break-before: page`), A4, Latin Modern Roman embedded
    // as a real font in regular, bold and italic.
    it('renders the thesis fixture as an A4 thesis chapter with Latin Modern embedded', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const thesis = THEME_PRESETS.find(p => p.id === 'thesis')?.theme
      if (!thesis) throw new Error('thesis preset missing')
      expect(thesis.customCss).toBeTruthy()
      const patch: unknown = JSON.parse(readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/thesis-chapter-patch.json', import.meta.url))), 'utf8'))
      const cover = typeof patch === 'object' && patch !== null && 'cover' in patch && typeof patch.cover === 'object' && patch.cover !== null ? patch.cover : {}
      const theme = { ...thesis, cover: { ...thesis.cover, ...cover } }
      await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(theme), doc.docId])
      const fixture = readFileSync(resolve(fileURLToPath(new URL('../../fixtures/theme-shots/thesis-chapter.md', import.meta.url))), 'utf8')
      const snapId = await insertYjsRow(doc.docId, fixture)

      const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
      expect(res.status).toBe(302)
      const manifest: unknown = JSON.parse(new TextDecoder().decode(
        await fetchRenderBytes(`renders/${doc.docId}/${snapId}/manifest.json`)
      ))
      const pageCount = typeof manifest === 'object' && manifest !== null && 'pageCount' in manifest ? manifest.pageCount : null
      expect(typeof pageCount).toBe('number')
      // Preview: 8 pages (title page, seven of the chapter).
      expect(Number(pageCount)).toBeGreaterThanOrEqual(7)
      expect(Number(pageCount)).toBeLessThanOrEqual(9)
      const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
      // A4 (210 × 297 mm ≈ 595 × 842 pt; Chromium rounds to its own grid).
      expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+59[45](?:\.\d+)?\s+84[12](?:\.\d+)?\s*\]/)
      const fonts = [...pdf.matchAll(/\/Subtype\s*\/(\w+)[^>]*?\/BaseFont\s*\/([\w+-]+)|\/BaseFont\s*\/([\w+-]+)[^>]*?\/Subtype\s*\/(\w+)/g)]
        .map(m => ({ subtype: m[1] ?? m[4] ?? '', name: m[2] ?? m[3] ?? '' }))
      const summary = fonts.map(f => `${f.name}:${f.subtype}`).join(', ')
      const lm = fonts.filter(f => /LMRoman/.test(f.name))
      expect(lm.length, summary).toBeGreaterThan(0)
      expect(new Set(lm.map(f => f.name.replace(/^[A-Z]{6}\+/, ''))).size, summary).toBeGreaterThanOrEqual(3)
      for (const f of fonts) expect(f.subtype, summary).not.toBe('Type3')
      expect(pdf, summary).not.toMatch(/\/Subtype\s*\/Type3/)

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
      const fontNames = [...pdf.matchAll(/\/(?:BaseFont|FontName)\s*\/([\w+-]+)/g)].map(m => m[1] ?? '')
      expect(fontNames.some(n => /Lora/i.test(n)), fontNames.join(', ')).toBe(true)
      expect(fontNames.some(n => /Playfair/i.test(n)), fontNames.join(', ')).toBe(true)
      expect(fontNames.some(n => /KaTeX/i.test(n)), fontNames.join(', ')).toBe(true)

      await wipeRendersFor(doc.docId)
    }, 90_000)

    // Chromium (Skia) embeds a variable font, or a CFF one, as Type 3
    // glyph procedures: bigger files, no hinting, refused by some print
    // shops. Documents get static TrueType cuts only (themeFonts.ts), so
    // no preset may produce a Type 3 font, in any text style it uses.
    it('embeds no Type 3 font in any built-in preset', async () => {
      const owner = await createUser()
      const body = [
        '# Heading one', '', 'Body text with **bold**, *italic*, ***bold italic*** and `inline code`.', '',
        '## Heading two', '', '### Heading three', '', '> A quotation, *emphasised*.', '',
        '| Item | Value |', '|---|---|', '| One | 1 |', '',
        '```ts', 'const answer: number = 42', '```', ''
      ].join('\n')
      const offenders: string[] = []
      for (const preset of THEME_PRESETS) {
        const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
        await testDb().query('UPDATE documents SET theme = $1 WHERE doc_id = $2', [JSON.stringify(preset.theme), doc.docId])
        const snapId = await insertYjsRow(doc.docId, body)
        const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
        expect(res.status, preset.id).toBe(302)
        const pdf = new TextDecoder('latin1').decode(await fetchRenderBytes(`renders/${doc.docId}/${snapId}/document.pdf`))
        const fonts = [...pdf.matchAll(/\/Subtype\s*\/(\w+)[^>]*?\/BaseFont\s*\/([\w+-]+)|\/BaseFont\s*\/([\w+-]+)[^>]*?\/Subtype\s*\/(\w+)/g)]
          .map(m => `${m[2] ?? m[3] ?? ''}:${m[1] ?? m[4] ?? ''}`)
        const type3 = (pdf.match(/\/Subtype\s*\/Type3/g) ?? []).length
        if (type3 > 0) offenders.push(`${preset.id}: ${type3} Type 3 font(s) — ${fonts.join(', ')}`)
        await wipeRendersFor(doc.docId)
      }
      expect(offenders).toEqual([])
    }, 600_000)

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
