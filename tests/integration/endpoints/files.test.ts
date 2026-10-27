import { describe, it, expect, beforeEach } from 'vitest'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import jwt from 'jsonwebtoken'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'
import { TEST_JWT_SECRET } from '../setup/env'
import { mintSessionJwt } from '~~/shared/test-helpers/jwt'

// GET /api/files/:docId/:fileId — returns 302 → presigned S3 URL when
// allowed, 403 when denied. Critical bug-fix regression target: pre-fix,
// the endpoint had NO authz check on private docs at all, silently leaking
// every private doc's images to anyone who guessed the fileId.

const FILE_ID = 'abc12345XYZ0.png'

function mintDocJwt(docId: string, userId: string | number = 'anonymous'): string {
  return mintSessionJwt(
    { docId, userId, userName: null, readOnly: false },
    { secret: TEST_JWT_SECRET }
  )
}

describe('GET /api/files/:docId/:fileId', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 404 for a nonexistent doc', async () => {
    // Ensure we don't leak "forbidden vs not found" via timing/shape.
    const res = await anonClient().get(`/api/files/nonexistent/${FILE_ID}`)
    expect(res.status).toBe(404)
  })

  it('returns 400 on malformed fileId (extension allow-list)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const res = await anonClient().get(`/api/files/${doc.docId}/evil.exe`)
    expect(res.status).toBe(400)
  })

  it('returns 400 on empty fileId shape', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const res = await anonClient().get(`/api/files/${doc.docId}/nocextension`)
    expect(res.status).toBe(400)
  })

  describe('public access modes', () => {
    it.each(['open-edit', 'open-view'] as const)('anonymous gets 302 on %s', async (mode) => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: mode })
      const res = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}`)
      expect(res.status).toBe(302)
      const location = res.headers.get('location')
      expect(location).toBeTruthy()
      // Presigned URL points at the test SeaweedFS and includes the docId/fileId.
      expect(location).toContain(`docs/${doc.docId}/${FILE_ID}`)
      expect(location).toContain('X-Amz-Signature')
    })
  })

  describe('private mode (regression guard for pre-fix silent leak)', () => {
    it('anonymous is denied', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const res = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}`)
      expect(res.status).toBe(403)
    })

    it('logged-in non-owner is denied', async () => {
      const owner = await createUser()
      const other = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(other.id)
      const res = await client.get(`/api/files/${doc.docId}/${FILE_ID}`)
      expect(res.status).toBe(403)
    })

    it('owner gets 302', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const client = await loggedInClient(owner.id)
      const res = await client.get(`/api/files/${doc.docId}/${FILE_ID}`)
      expect(res.status).toBe(302)
      // Regression: the per-viewer redirect carried no cache headers, so a
      // shared cache in front of the app could replay it to other viewers.
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    })

    it.each(['admin', 'editor', 'viewer'] as const)('workspace %s gets 302', async (role) => {
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
      const res = await client.get(`/api/files/${doc.docId}/${FILE_ID}`)
      expect(res.status).toBe(302)
    })

    it('anonymous with a valid doc JWT bearer is allowed', async () => {
      // Password-verified anon path: the /password endpoint hands back a
      // scoped JWT that `hasValidDocJwt` accepts as the "I verified
      // access" witness on the file endpoint.
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const token = mintDocJwt(doc.docId)
      const res = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(302)
    })

    it('anonymous with a JWT for a DIFFERENT doc is denied', async () => {
      // Cross-doc JWT must not grant access — verifies the docId claim
      // check in hasValidDocJwt.
      const owner = await createUser()
      const targetDoc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const otherDoc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
      const token = mintDocJwt(otherDoc.docId) // signed for a different doc
      const res = await anonClient().get(`/api/files/${targetDoc.docId}/${FILE_ID}`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(403)
    })

    it('anonymous with an invalidly-signed JWT is denied', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const badToken = jwt.sign({ docId: doc.docId }, 'wrong-secret')
      const res = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}`, {
        headers: { authorization: `Bearer ${badToken}` }
      })
      expect(res.status).toBe(403)
    })

    it('anonymous with a valid doc JWT via ?token= query param is allowed', async () => {
      // <img src> requests can't set an Authorization header, so the
      // file endpoint also accepts the token in the query string.
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
      const token = mintDocJwt(doc.docId)
      const res = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}?token=${token}`)
      expect(res.status).toBe(302)
    })
  })

  describe('password-protected mode', () => {
    it('anonymous without JWT is denied', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'password-protected'
      })
      const res = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}`)
      expect(res.status).toBe(403)
    })

    it('anonymous with valid doc JWT is allowed', async () => {
      const owner = await createUser()
      const doc = await createDoc({
        ownerId: owner.id,
        accessMode: 'password-protected'
      })
      const token = mintDocJwt(doc.docId)
      const res = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}?token=${token}`)
      expect(res.status).toBe(302)
    })

    it.each(['admin', 'editor', 'viewer'] as const)('workspace %s bypasses password (no JWT needed)', async (role) => {
      // Bug-fix regression guard: pre-fix, password-protected branch
      // excluded workspace members. Spec says members bypass password.
      const creator = await createUser()
      const member = await createUser()
      const ws = await createWorkspace(creator.id)
      await setMemberRole(ws.workspaceId, member.id, role)
      const doc = await createDoc({
        ownerId: creator.id,
        workspaceId: ws.workspaceId,
        accessMode: 'password-protected'
      })
      const client = await loggedInClient(member.id)
      const res = await client.get(`/api/files/${doc.docId}/${FILE_ID}`)
      expect(res.status).toBe(302)
    })
  })

  // Regression: the redirect target used to serve whatever type the
  // object was stored with, so an image key could come back as HTML.
  describe('response type is forced from the extension', () => {
    const s3 = new S3Client({
      endpoint: 'http://127.0.0.1:8334',
      region: 'us-east-1',
      credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
      forcePathStyle: true
    })

    it('an object stored as text/html is served as image/png', async () => {
      const owner = await createUser()
      const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
      const key = `docs/${doc.docId}/${FILE_ID}`
      await s3.send(new PutObjectCommand({ Bucket: 'ypad', Key: key, Body: 'not really html', ContentType: 'text/html' }))
      try {
        const res = await anonClient().get(`/api/files/${doc.docId}/${FILE_ID}`)
        expect(res.status).toBe(302)
        const location = res.headers.get('location') ?? ''
        const obj = await fetch(location)
        expect(obj.status).toBe(200)
        expect(obj.headers.get('content-type')).toBe('image/png')
        expect(obj.headers.get('content-disposition')).toBe(`inline; filename="${FILE_ID}"`)
      } finally {
        await s3.send(new DeleteObjectCommand({ Bucket: 'ypad', Key: key })).catch(() => {})
      }
    })
  })
})
