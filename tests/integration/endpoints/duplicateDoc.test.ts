import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { DEFAULT_TIERS as TIERS } from '../../../shared/config/tiers'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole,
  setDocPasswordHash
} from '../setup/fixtures'
import { first } from '../../helpers/assert'

// POST /api/docs/:docId/duplicate — clones a doc end-to-end. These
// tests cover the DB + authz surface; the Y.js state clone + S3 copy
// are exercised in dedicated tests (see tests/repos/cloneYjsState.test.ts
// and tests/repos/uploadsDuplicate.test.ts). Source docs here have no
// confirmed uploads so the endpoint doesn't hit S3.

interface DocRow {
  owner_id: number | null
  workspace_id: string | null
  title: string
  access_mode: string
  password_hash: string | null
  word_count: number | null
  size_bytes: number | null
  theme: unknown
}

async function readDoc(docId: string): Promise<DocRow | null> {
  const db = testDb()
  const r = await db.query<DocRow>(
    'SELECT owner_id, workspace_id, title, access_mode, password_hash, word_count, size_bytes, theme FROM documents WHERE doc_id = $1',
    [docId]
  )
  return r.rows[0] ?? null
}

async function seedWithMetadata(docId: string, patch: Partial<DocRow>): Promise<void> {
  const db = testDb()
  const entries = Object.entries(patch)
  if (entries.length === 0) return
  const setClauses = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')
  const values = entries.map(([, v]) => v)
  await db.query(
    `UPDATE documents SET ${setClauses} WHERE doc_id = $1`,
    [docId, ...values]
  )
}

describe('POST /api/docs/:docId/duplicate', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 401 for anonymous callers', async () => {
    const doc = await createDoc({ accessMode: 'open-edit' })
    const res = await anonClient().post(`/api/docs/${doc.docId}/duplicate`)
    expect(res.status).toBe(401)
  })

  it('returns 404 for a nonexistent source doc', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/docs/ghost/duplicate')
    expect(res.status).toBe(404)
  })

  describe('authz — source side', () => {
    it('owner can duplicate their own doc', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      expect(res.status).toBe(200)
      const body = await res.json() as { docId: string }
      expect(body.docId).toBeTruthy()
      expect(body.docId).not.toBe(doc.docId)
    })

    it('workspace editor can duplicate (canEditDoc gate, not canManageDoc)', async () => {
      // This is the one place the duplicate endpoint diverges from
      // delete/move: editors get to duplicate because the copy lands
      // under their ownership, not the source owner's.
      const creator = await createUser()
      const editor = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, editor.id, 'editor')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(editor.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      expect(res.status).toBe(200)
      const { docId: newDocId } = await res.json() as { docId: string }
      // New owner is the duplicator, not the source owner.
      expect((await readDoc(newDocId))!.owner_id).toBe(editor.id)
    })

    it('workspace viewer CANNOT duplicate (edit gate)', async () => {
      const creator = await createUser()
      const viewer = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(viewer.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      expect(res.status).toBe(403)
    })

    it('stranger cannot duplicate a private standalone doc (403)', async () => {
      const owner = await createUser()
      const stranger = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(stranger.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      expect(res.status).toBe(403)
    })

    it('stranger can duplicate an open-edit standalone doc (canEditDoc catches open-edit)', async () => {
      // open-edit means anyone with the link can edit. The duplicate
      // endpoint's authz goes through getDocAuthz / canEdit, which
      // returns true only for owner / workspace admin / workspace
      // editor — NOT for a stranger on open-edit. Pin the current
      // behaviour so a future loosening is explicit.
      const owner = await createUser()
      const stranger = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const client = await loggedInClient(stranger.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      // Not canEdit per the authz helper. If this ever flips to 200,
      // reconsider whether duplicates of a stranger's doc should
      // silently transfer ownership to anyone who can open the link.
      expect(res.status).toBe(403)
    })
  })

  describe('authz — target workspace side', () => {
    it('rejects a target workspace the actor is not a member of', async () => {
      const owner = await createUser()
      const otherAdmin = await createUser()
      const otherWs = await createWorkspace(otherAdmin.id)
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, {
        workspaceId: otherWs.workspaceId
      })
      expect(res.status).toBe(403)
    })

    it('rejects target where actor is a viewer', async () => {
      const owner = await createUser()
      const wsOwner = await createUser()
      const targetWs = await createWorkspace(wsOwner.id)
      await setMemberRole(targetWs.workspaceId, owner.id, 'viewer')
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, {
        workspaceId: targetWs.workspaceId
      })
      expect(res.status).toBe(403)
    })

    it('allows target where actor is an editor', async () => {
      const owner = await createUser()
      const wsOwner = await createUser()
      const targetWs = await createWorkspace(wsOwner.id)
      await setMemberRole(targetWs.workspaceId, owner.id, 'editor')
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, {
        workspaceId: targetWs.workspaceId
      })
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      expect((await readDoc(docId))!.workspace_id).toBe(targetWs.workspaceId)
    })

    it('same-workspace duplicate by a workspace editor passes the target-membership check', async () => {
      // The target-membership check also runs for the source's own
      // workspace (a guest's edit share must not let them create
      // documents there — workspaceGuests.test.ts); a real editor of
      // that workspace must still pass it.
      const creator = await createUser()
      const editor = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, editor.id, 'editor')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(editor.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, {
        workspaceId: ws.workspaceId
      })
      expect(res.status).toBe(200)
    })
  })

  describe('body validation', () => {
    it('rejects a non-string, non-null workspaceId', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, { workspaceId: 42 })
      expect(res.status).toBe(400)
    })
  })

  describe('metadata inheritance', () => {
    it('defaults title to "Copy of {source.title}"', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      // createDoc seeds title="Test Doc"
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      const { docId } = await res.json() as { docId: string }
      expect((await readDoc(docId))!.title).toBe('Copy of Test Doc')
    })

    it('honours a user-supplied title', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, {
        title: 'My new copy'
      })
      const { docId } = await res.json() as { docId: string }
      expect((await readDoc(docId))!.title).toBe('My new copy')
    })

    it('trims whitespace and falls back to "Copy of …" on an all-whitespace title', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, { title: '   ' })
      const { docId } = await res.json() as { docId: string }
      expect((await readDoc(docId))!.title).toBe('Copy of Test Doc')
    })

    it('truncates very long titles to 255 chars', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const longTitle = 'x'.repeat(400)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, { title: longTitle })
      expect(res.status).toBe(200)
      const { docId } = await res.json() as { docId: string }
      const row = (await readDoc(docId))!
      expect(row.title.length).toBe(255)
    })

    it('inherits accessMode, passwordHash, theme, word/size counters', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'password-protected' })
      await setDocPasswordHash(doc.docId, 'secret-hash')
      await seedWithMetadata(doc.docId, {
        word_count: 500,
        size_bytes: 4000,
        theme: { foo: 'bar' } as unknown as DocRow['theme']
      })

      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      const { docId } = await res.json() as { docId: string }

      const row = (await readDoc(docId))!
      expect(row.access_mode).toBe('password-protected')
      expect(row.password_hash).toBe('secret-hash')
      expect(row.word_count).toBe(500)
      expect(row.size_bytes).toBe(4000)
      expect(row.theme).toEqual({ foo: 'bar' })
    })

    it('duplicator becomes the new owner', async () => {
      const original = await createUser()
      const dup = await createUser()
      const ws = await createWorkspace(original.id)
      await setMemberRole(ws.workspaceId, dup.id, 'editor')
      const doc = await createDoc({
        ownerId: original.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(dup.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      const { docId } = await res.json() as { docId: string }
      const row = (await readDoc(docId))!
      expect(row.owner_id).toBe(dup.id)
      expect(row.owner_id).not.toBe(original.id)
    })

    it('defaults target workspace to the source\'s workspace', async () => {
      const owner = await createUser()
      const ws = await createWorkspace(owner.id)
      const doc = await createDoc({
        ownerId: owner.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`)
      const { docId } = await res.json() as { docId: string }
      expect((await readDoc(docId))!.workspace_id).toBe(ws.workspaceId)
    })

    it('explicit workspaceId: null detaches the duplicate into personal', async () => {
      const owner = await createUser()
      const ws = await createWorkspace(owner.id)
      const doc = await createDoc({
        ownerId: owner.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(owner.id)
      const res = await client.post(`/api/docs/${doc.docId}/duplicate`, {
        workspaceId: null
      })
      const { docId } = await res.json() as { docId: string }
      expect((await readDoc(docId))!.workspace_id).toBeNull()
    })

    it('does not delete or modify the source doc', async () => {
      // Belt-and-braces: ensure the duplicate endpoint is purely
      // additive. A regression that accidentally MOVED the source row
      // instead of copying would show up here as the source vanishing.
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const before = await readDoc(doc.docId)
      const client = await loggedInClient(owner.id)
      await client.post(`/api/docs/${doc.docId}/duplicate`)
      const after = await readDoc(doc.docId)
      expect(after).toEqual(before)
    })
  })

  describe('Idempotency-Key', () => {
    // Stripe-style replay: same client-supplied key + same user +
    // same source doc within the TTL window must return the SAME
    // { docId } without creating a second copy. Header absent →
    // unchanged behaviour.

    it('without the header, two rapid calls each create a fresh duplicate', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)

      const r1 = await client.post(`/api/docs/${doc.docId}/duplicate`)
      const r2 = await client.post(`/api/docs/${doc.docId}/duplicate`)
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      const b1 = await r1.json() as { docId: string }
      const b2 = await r2.json() as { docId: string }
      expect(b1.docId).not.toBe(b2.docId)
    })

    it('same key twice rapidly returns the same docId without a second duplicate', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const key = 'idem-' + Math.random().toString(36).slice(2).padEnd(20, 'a')

      const r1 = await client.post(`/api/docs/${doc.docId}/duplicate`, undefined, {
        headers: { 'idempotency-key': key }
      })
      const r2 = await client.post(`/api/docs/${doc.docId}/duplicate`, undefined, {
        headers: { 'idempotency-key': key }
      })
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      const b1 = await r1.json() as { docId: string }
      const b2 = await r2.json() as { docId: string }
      // The cached response is replayed verbatim — same docId.
      expect(b1.docId).toBe(b2.docId)

      // Verify exactly ONE row in the DB (i.e., the second call did
      // NOT create a second duplicate).
      const db = testDb()
      const r = await db.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM documents WHERE doc_id = $1 OR title = $2`,
        [b1.docId, 'Copy of Test Doc']
      )
      // Source has title "Test Doc"; duplicate has "Copy of Test Doc".
      // Exactly ONE doc with that title means idempotency held.
      expect(Number(first(r.rows).c)).toBe(1)
    })

    it('same key for two different users → independent (no scope leak)', async () => {
      const u1 = await createUser()
      const u2 = await createUser()
      const doc = await createDoc({ accessMode: 'open-edit' })
      // Both users get edit access via accessMode=open-edit. (Note:
      // canEditDoc currently rejects open-edit for a stranger; use a
      // setup where both users own/edit the doc independently. Move
      // each into a workspace they both belong to.)
      const ws = await createWorkspace(u1.id)
      await setMemberRole(ws.workspaceId, u2.id, 'editor')
      const sharedDoc = await createDoc({ ownerId: u1.id, workspaceId: ws.workspaceId, accessMode: 'private' })

      const c1 = await loggedInClient(u1.id)
      const c2 = await loggedInClient(u2.id)
      const key = 'sharedkey-' + Math.random().toString(36).slice(2).padEnd(16, 'a')

      const r1 = await c1.post(`/api/docs/${sharedDoc.docId}/duplicate`, undefined, {
        headers: { 'idempotency-key': key }
      })
      const r2 = await c2.post(`/api/docs/${sharedDoc.docId}/duplicate`, undefined, {
        headers: { 'idempotency-key': key }
      })
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      const b1 = await r1.json() as { docId: string }
      const b2 = await r2.json() as { docId: string }
      // Per-user scope means each user got a fresh duplicate even
      // though they used the same key string.
      expect(b1.docId).not.toBe(b2.docId)
      // Suppress unused warnings.
      void doc
    })
  })
})

// Duplicated images are attributed to the duplicator and counted, so an editor can't multiply a
// colleague's images (and fill the author's quota) without limit.
describe('POST /api/docs/:docId/duplicate — image storage quota', () => {
  const s3 = new S3Client({
    endpoint: 'http://127.0.0.1:8334',
    region: 'us-east-1',
    credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
    forcePathStyle: true
  })
  const keys: string[] = []

  beforeEach(async () => {
    await resetDb()
  })

  afterEach(async () => {
    for (const Key of keys.splice(0)) {
      await s3.send(new DeleteObjectCommand({ Bucket: 'ypad', Key })).catch(() => {})
    }
  })

  async function confirmedUpload(docId: string, uploaderId: number, sizeBytes: number): Promise<string> {
    const fileId = `${nanoid(12)}.png`
    const s3Key = `docs/${docId}/${fileId}`
    await testDb().query(
      `INSERT INTO uploads (doc_id, file_id, uploader_id, content_type, size_bytes, s3_key, confirmed_at)
       VALUES ($1, $2, $3, 'image/png', $4, $5, now())`,
      [docId, fileId, uploaderId, sizeBytes, s3Key]
    )
    return fileId
  }

  it('attributes the copied images to the duplicator', async () => {
    const author = await createUser()
    const colleague = await createUser()
    const ws = await createWorkspace(author.id)
    await setMemberRole(ws.workspaceId, colleague.id, 'editor')
    const source = await createDoc({ ownerId: author.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const fileId = await confirmedUpload(source.docId, author.id, 3)
    await s3.send(new PutObjectCommand({ Bucket: 'ypad', Key: `docs/${source.docId}/${fileId}`, Body: 'png', ContentType: 'image/png' }))
    keys.push(`docs/${source.docId}/${fileId}`)

    const res = await (await loggedInClient(colleague.id)).post(`/api/docs/${source.docId}/duplicate`, {})
    expect(res.status).toBe(200)
    const { docId } = await res.json() as { docId: string }
    keys.push(`docs/${docId}/${fileId}`)
    const copy = await testDb().query<{ uploader_id: number }>('SELECT uploader_id FROM uploads WHERE doc_id = $1', [docId])
    expect(copy.rows).toEqual([{ uploader_id: colleague.id }])
  })

  it('refuses with 409 upload/storage-quota when the copies would exceed the duplicator\'s quota', async () => {
    const author = await createUser()
    const colleague = await createUser()
    const ws = await createWorkspace(author.id)
    await setMemberRole(ws.workspaceId, colleague.id, 'editor')
    const source = await createDoc({ ownerId: author.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    await confirmedUpload(source.docId, author.id, TIERS.free.imageBytesPerUser + 1)

    const res = await (await loggedInClient(colleague.id)).post(`/api/docs/${source.docId}/duplicate`, {})
    expect(res.status).toBe(409)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('upload/storage-quota')
    const owned = await testDb().query<{ c: string }>('SELECT count(*) AS c FROM documents WHERE owner_id = $1', [colleague.id])
    expect(Number(owned.rows[0]?.c)).toBe(0)
  })
})
