// Integration tests for the view_pages + get_page_count AI tools against
// the REAL Playwright renderer container (no stub). Drives the full chain:
// /api/_test/exec-ai-tool → executeFunctionByName → renderClient → POST
// renderer-test → Chromium navigates the print page → paged.js paginates
// → screenshots upload to S3 → handler reads them back and returns
// inlineData parts.
//
// Test stack: postgres-test + valkey-test + seaweedfs-test + renderer-test.
// Tests are slow (~5-10s each), that's the actual cost of a real render.
// The previous stub-based tests took ~50ms each; we trade speed for
// confidence that the print page + paged.js + screenshot capture all work.

import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser, createDoc, createWorkspace } from '../setup/fixtures'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { first } from '../../helpers/assert'

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

// Insert a Y.Doc row with REAL update bytes, the renderer replays this
// into markdown, so empty docs paginate to zero pages and the renderer
// errors. Fixture content must produce at least 1 page.
async function insertYjsRow(docname: string, content: string): Promise<number> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, content)
  const update = Y.encodeStateAsUpdate(ydoc)
  const db = testDb()
  const r = await db.query<{ id: number }>(
    `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2) RETURNING id`,
    [docname, Buffer.from(update)]
  )
  return Number(first(r.rows).id)
}

// Multi-page fixture (paginates to 3+ pages on the default theme). Used
// across all tests so they share a cache hit on the first slow render.
function multiPageBody(): string {
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.'
  const sections = ['Introduction', 'Background', 'Methodology', 'Results', 'Discussion']
  const parts = ['# AI view_pages fixture\n\n']
  for (const s of sections) {
    parts.push(`## ${s}\n\n${para}\n\n${para}\n\n- bullet a\n- bullet b\n- bullet c\n\n`)
  }
  return parts.join('')
}

interface ToolResponse {
  isError: boolean
  content: string
  extraParts: Array<{ inlineData?: { mimeType?: string, data?: string } }> | null
}

async function execTool(
  client: { post: (path: string, body: unknown) => Promise<Response> },
  docId: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ status: number, body: ToolResponse }> {
  const res = await client.post('/api/_test/exec-ai-tool', { docId, name, args })
  return { status: res.status, body: await res.json() as ToolResponse }
}

beforeEach(async () => {
  await resetDb()
})

describe('get_page_count tool: real renderer', () => {
  it('returns the actual rendered page count', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    await insertYjsRow(doc.docId, multiPageBody())
    const client = await loggedInClient(owner.id)

    const { status, body } = await execTool(client, doc.docId, 'get_page_count')

    expect(status).toBe(200)
    expect(body.isError).toBe(false)
    // Multi-page fixture paginates to ≥2, extract the number from the
    // AI-facing string and verify it's ≥2.
    const m = body.content.match(/(\d+)\s+page/i)
    expect(m).toBeTruthy()
    const pageCount = parseInt(m![1]!, 10)
    expect(pageCount).toBeGreaterThanOrEqual(2)

    await wipeRendersFor(doc.docId)
  }, 90_000)
})

describe('view_pages tool: real renderer', () => {
  it('returns inlineData PNG parts whose bytes start with the PNG signature', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    await insertYjsRow(doc.docId, multiPageBody())
    const client = await loggedInClient(owner.id)

    const { status, body } = await execTool(client, doc.docId, 'view_pages', {
      pages: [1, 2]
    })

    expect(status).toBe(200)
    expect(body.isError).toBe(false)
    expect(body.extraParts).not.toBeNull()
    expect(body.extraParts).toHaveLength(2)

    for (const part of body.extraParts!) {
      expect(part.inlineData?.mimeType).toBe('image/png')
      expect(part.inlineData?.data).toBeTruthy()
      const bytes = Buffer.from(part.inlineData!.data!, 'base64')
      // PNG signature: 89 50 4E 47 0D 0A 1A 0A
      expect(bytes[0]).toBe(0x89)
      expect(bytes[1]).toBe(0x50)
      expect(bytes[2]).toBe(0x4E)
      expect(bytes[3]).toBe(0x47)
      // Real renders are well over a few KB; the canned 67-byte placeholder
      // we used in the stub would fail here, which is the point.
      expect(bytes.byteLength).toBeGreaterThan(5_000)
    }

    await wipeRendersFor(doc.docId)
  }, 90_000)

  it('reads the pages of a document whose workspace has brand inputs (fingerprinted render folder)', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    await insertYjsRow(doc.docId, multiPageBody())
    // A workspace logo is enough to give the document a brand fingerprint,
    // so the render lands in renders/<doc>/<snapshot>-<fingerprint>/.
    await testDb().query(
      `INSERT INTO workspace_brand_assets (id, workspace_id, kind, format, name, size_bytes, s3_key)
       VALUES ('logoAAAAAAAAAAAA', $1, 'image', 'png', 'Logo', 68, $2)`,
      [ws.workspaceId, `workspaces/${ws.workspaceId}/brand/logoAAAAAAAAAAAA.png`]
    )
    const client = await loggedInClient(owner.id)

    const { body } = await execTool(client, doc.docId, 'view_pages', { pages: [1] })

    expect(body.content).not.toMatch(/failed/i)
    expect(body.isError).toBe(false)
    expect(body.extraParts).toHaveLength(1)
    const list = await s3.send(new ListObjectsV2Command({ Bucket: 'ypad', Prefix: `renders/${doc.docId}/` }))
    expect((list.Contents ?? []).some(o => /\/\d+-[0-9a-f]{16}\/page-1\.png$/.test(o.Key ?? ''))).toBe(true)

    await wipeRendersFor(doc.docId)
  }, 90_000)

  it('returns an error when a requested page is out of range', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    await insertYjsRow(doc.docId, multiPageBody())
    const client = await loggedInClient(owner.id)

    // Multi-page fixture renders to <50 pages; page 99 is out of range.
    const { body } = await execTool(client, doc.docId, 'view_pages', { pages: [99] })

    expect(body.isError).toBe(true)
    expect(body.content).toMatch(/out of range/i)

    await wipeRendersFor(doc.docId)
  }, 90_000)

  it('deduplicates repeated page numbers', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    await insertYjsRow(doc.docId, multiPageBody())
    const client = await loggedInClient(owner.id)

    const { body } = await execTool(client, doc.docId, 'view_pages', {
      pages: [1, 1, 2, 2, 1]
    })

    expect(body.isError).toBe(false)
    // Only 2 unique pages → 2 inline parts.
    expect(body.extraParts).toHaveLength(2)

    await wipeRendersFor(doc.docId)
  }, 90_000)
})
