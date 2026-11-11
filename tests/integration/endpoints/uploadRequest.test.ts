import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'

// POST /api/upload/request: mints a presigned S3 PUT for a doc image. The write gate is `canEditDoc`, the same
// helper every other write endpoint uses: it must refuse any authenticated user who knows a `private` or
// `password-protected` doc id (else they could presign a PUT into that doc's S3 prefix), must not block
// workspace editors on `open-view` docs, and `open-edit` stays open to anyone (that's the feature).

const BODY = {
  filename: 'shot.png',
  contentType: 'image/png',
  size: 1024
}

function reqBody(docId: string) {
  return { docId, ...BODY }
}

describe('POST /api/upload/request', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects anonymous (no session) with 401', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const res = await anonClient().post('/api/upload/request', reqBody(doc.docId))
    expect(res.status).toBe(401)
  })

  it('refuses content types that are names every object inherits (constructor, toString)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const client = await loggedInClient(owner.id)
    for (const contentType of ['constructor', 'toString', '__proto__', 'image/svg+xml']) {
      const res = await client.post('/api/upload/request', { ...reqBody(doc.docId), contentType })
      expect(res.status, contentType).toBe(415)
      expect((await res.json() as { data?: { code?: string } }).data?.code, contentType).toBe('upload/unsupported-format')
    }
  })

  it('404s a doc that does not exist (no presigned PUT for arbitrary ids)', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/upload/request', reqBody('doc-doesnotexist'))
    expect(res.status).toBe(404)
  })

  describe('open-edit — anyone authenticated may upload', () => {
    it('logged-in non-owner gets a presigned URL', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const client = await loggedInClient(other.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.uploadUrl).toBeTruthy()
      expect(body.key).toContain(`docs/${doc.docId}/`)
    })
  })

  // The browser PUTs straight to S3 with the presigned URL. The client must not sign a default CRC32 into every
  // PutObject (@aws-sdk 3.729+ computes it over the EMPTY body at presign time), or S3 rejects every real upload
  // with 400 (images and knowledge files alike). Only a real PUT against the test SeaweedFS catches that;
  // checking for a URL does not.
  it('the presigned URL accepts the upload the browser sends', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const client = await loggedInClient(owner.id)
    const res = await client.post('/api/upload/request', reqBody(doc.docId))
    expect(res.status).toBe(200)
    const { uploadUrl } = await res.json() as { uploadUrl: string }
    expect(uploadUrl).not.toMatch(/x-amz-checksum/i)

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': BODY.contentType },
      body: new Uint8Array(BODY.size).fill(7)
    })
    expect(put.status, await put.text()).toBe(200)
  })

  describe('open-view — owner/members only', () => {
    it('owner is allowed', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
      const client = await loggedInClient(owner.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(200)
    })

    it('logged-in non-owner is denied (403)', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
      const client = await loggedInClient(other.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(403)
    })

    it('workspace editor is allowed (previously wrongly blocked)', async () => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'editor')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'open-view'
      })
      const client = await loggedInClient(member.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(200)
    })
  })

  describe('private — authenticated users without edit rights cannot upload', () => {
    it('logged-in non-owner is denied (403)', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(other.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(403)
    })

    it('owner is allowed', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(200)
    })

    it.each(['admin', 'editor'] as const)('workspace %s is allowed', async (role) => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, role)
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(member.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(200)
    })

    it('workspace viewer is denied (403)', async () => {
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, 'viewer')
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'private'
      })
      const client = await loggedInClient(member.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(403)
    })
  })

  describe('password-protected — owner/members only (upload cannot prove password)', () => {
    it('logged-in non-owner is denied (403)', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'password-protected' })
      const client = await loggedInClient(other.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(403)
    })

    it('owner is allowed', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'password-protected' })
      const client = await loggedInClient(owner.id)
      const res = await client.post('/api/upload/request', reqBody(doc.docId))
      expect(res.status).toBe(200)
    })
  })
})
