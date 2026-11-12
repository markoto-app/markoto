// Integration tests for GET /api/_internal/render-bootstrap — the
// endpoint the renderer container hits during the SSR pass of the
// internal print page (`app/pages/_internal/render/[docId].vue`).
// Validates the render-token, server-replays the doc's Y.js history,
// returns the materialized markdown + theme + title + snapshotId.
//
// Auth contract under test:
//   - Valid render-token + matching docId → 200 with markdown body +
//     theme + title + snapshotId.
//   - Missing query params → 400.
//   - Garbage / wrong-secret token → 403.
//   - Expired token → 403.
//   - Token signed for doc-A but presented under doc-B → 403.
//   - Wrong scope (the same internal secret could in principle be
//     reused; explicit scope check guards this) → 403.
//   - Doc deleted between snapshot capture and render → 404.

import { describe, it, expect, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'
import { anonClient } from '../setup/client'
import { createUser, createDoc } from '../setup/fixtures'
import { TEST_INTERNAL_SECRET } from '../setup/env'
import { mintRenderJwt } from '~~/tests/helpers/jwt'

function mintRenderToken(docId: string, snapshotId: number, opts: {
  scope?: string
  ttl?: number
  secret?: string
} = {}): string {
  // Happy path goes through the shared `mintRenderJwt` so the wire
  // shape (`scope: 'render'` + 60s TTL) is pinned by the contract.
  // Adversarial cases (scope override, secret rotation, expired
  // tokens) take the raw `jwt.sign` branch — those are testing the
  // verifier's reject paths so they MUST be free to mint malformed
  // shapes.
  if (opts.scope === undefined && opts.secret === undefined && opts.ttl === undefined) {
    return mintRenderJwt({ docId, snapshotId }, { secret: TEST_INTERNAL_SECRET })
  }
  return jwt.sign(
    { docId, snapshotId, scope: opts.scope ?? 'render' },
    opts.secret ?? TEST_INTERNAL_SECRET,
    { expiresIn: opts.ttl ?? 60 }
  )
}

beforeEach(async () => {
  await resetDb()
})

describe('GET /api/_internal/render-bootstrap', () => {
  it('returns server-replayed markdown + metadata for a valid render-token', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private', title: 'My Doc' })
    const token = mintRenderToken(doc.docId, 42)

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${doc.docId}&t=${token}`
    )

    expect(res.status).toBe(200)
    const body = await res.json() as {
      snapshotId: number
      markdown: string
      title: string
      theme: unknown
      description: string
      audience: string
      language: string
    }
    expect(body.snapshotId).toBe(42)
    expect(body.title).toBe('My Doc')
    // markdown is a string (empty when no yjs rows exist for this doc).
    expect(typeof body.markdown).toBe('string')
    // Doc-row metadata fields all present so the print page can paint
    // before any client-side work.
    expect(typeof body.description).toBe('string')
    expect(typeof body.audience).toBe('string')
    expect(typeof body.language).toBe('string')
  })

  it('returns 400 when docId or t is missing', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const token = mintRenderToken(doc.docId, 1)

    // Missing t.
    const r1 = await anonClient().get(`/api/_internal/render-bootstrap?docId=${doc.docId}`)
    expect(r1.status).toBe(400)

    // Missing docId.
    const r2 = await anonClient().get(`/api/_internal/render-bootstrap?t=${token}`)
    expect(r2.status).toBe(400)
  })

  it('returns 403 on a token signed with the wrong secret', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const token = mintRenderToken(doc.docId, 1, { secret: 'an-unrelated-secret' })

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${doc.docId}&t=${token}`
    )
    expect(res.status).toBe(403)
  })

  it('returns 403 on an expired render-token', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const token = mintRenderToken(doc.docId, 1, { ttl: -1 })

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${doc.docId}&t=${token}`
    )
    expect(res.status).toBe(403)
  })

  it('returns 403 on a render-token signed for a different doc (cross-doc replay defence)', async () => {
    const ownerA = await createUser()
    const ownerB = await createUser()
    const docA = await createDoc({ ownerId: ownerA.id })
    const docB = await createDoc({ ownerId: ownerB.id })
    const tokenForA = mintRenderToken(docA.docId, 1)

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${docB.docId}&t=${tokenForA}`
    )
    expect(res.status).toBe(403)
  })

  it('returns 403 on a token with the wrong scope (defence-in-depth)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const token = mintRenderToken(doc.docId, 1, { scope: 'kick-user' })

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${doc.docId}&t=${token}`
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 when the doc was deleted between snapshot and render', async () => {
    // Render token is signed; doc itself doesn't exist. The handler
    // verifies the token first (so we know the secret + scope are
    // legitimate), then looks up the doc and 404s when it's gone.
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const token = mintRenderToken(doc.docId, 1)

    // Delete the doc OUTSIDE the app — direct DB delete avoids the
    // delete cascade's S3 + sync notify side effects which are
    // irrelevant for this auth-flow test.
    const { testDb } = await import('../setup/db')
    await testDb().query('DELETE FROM documents WHERE doc_id = $1', [doc.docId])

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${doc.docId}&t=${token}`
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 on a malformed token without leaking which check failed', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${doc.docId}&t=not.a.jwt`
    )
    expect(res.status).toBe(403)
    // Error message should be generic — not "scope mismatch" or
    // "expired" or "wrong signature". The endpoint collapses every
    // verify failure into the same 403 to avoid timing/shape oracles.
    const body = await res.json() as { message?: string }
    expect(body.message).toMatch(/invalid/i)
  })

  // The print page gives its file-access token only to these uploads.
  it('lists the doc\'s confirmed uploads only (not pending ones, not other docs\')', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const other = await createDoc({ ownerId: owner.id })
    const insert = (docId: string, fileId: string, confirmed: boolean) => testDb().query(
      `INSERT INTO uploads (doc_id, file_id, uploader_id, content_type, size_bytes, s3_key, confirmed_at)
       VALUES ($1, $2, $3, 'image/png', 10, $4, ${confirmed ? 'now()' : 'NULL'})`,
      [docId, fileId, owner.id, `docs/${docId}/${fileId}`]
    )
    await insert(doc.docId, 'AbCdEfGhIjKl.png', true)
    await insert(doc.docId, 'PendingPend1.png', false)
    await insert(other.docId, 'OtherDocFile.png', true)

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${doc.docId}&t=${mintRenderToken(doc.docId, 1)}`
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ fileIds: ['AbCdEfGhIjKl.png'] })
  })

  // An anonymous doc's theme (and any property change made by someone other than the owner) lives only in
  // Y.js `meta`; the row's theme stays NULL because only the owner's editor persists it via PUT /meta. The
  // bootstrap must read Y.js meta, otherwise the server PDF of an anonymous doc comes out in the default theme.
  it('takes theme + properties from the replayed Y.js meta (anonymous doc, row theme NULL)', async () => {
    const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')?.theme
    expect(arxiv).toBeDefined()
    const doc = await createDoc({ ownerId: null, title: 'Row title' })
    const ydoc = new Y.Doc()
    ydoc.getText('content').insert(0, '# Hello\n')
    const ymeta = ydoc.getMap('meta')
    ymeta.set('theme', arxiv)
    ymeta.set('title', 'Live title')
    ymeta.set('language', 'de')
    const inserted = await testDb().query<{ id: number }>(
      `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2) RETURNING id`,
      [doc.docId, Buffer.from(Y.encodeStateAsUpdate(ydoc))]
    )
    const snapshotId = Number(inserted.rows[0]?.id)

    const res = await anonClient().get(
      `/api/_internal/render-bootstrap?docId=${doc.docId}&t=${mintRenderToken(doc.docId, snapshotId)}`
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      markdown: '# Hello\n',
      theme: arxiv,
      title: 'Live title',
      language: 'de'
    })
  })
})
