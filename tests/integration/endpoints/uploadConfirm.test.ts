import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'

// POST /api/upload/confirm. Regression target: pre-fix the route took any
// `key` from the body, HEADed it (404-vs-415 existence oracle for the whole
// bucket) and DELETED it when the bytes didn't match the extension — so an
// ordinary user could delete e.g. `backups/postgres/*.sql.gz.gpg`. The key
// must now resolve to the caller's own pending `uploads` row first.

const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:8334',
  region: 'us-east-1',
  credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
  forcePathStyle: true
})
const BUCKET = 'ypad'

// 1x1 transparent PNG.
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
))

const seeded: string[] = []

async function seed(key: string, body: Uint8Array): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }))
  seeded.push(key)
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function requestUpload(userId: number, docId: string): Promise<{ key: string, uploadUrl: string }> {
  const client = await loggedInClient(userId)
  const res = await client.post('/api/upload/request', {
    docId,
    filename: 'shot.png',
    contentType: 'image/png',
    size: PNG.length
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { key: string, uploadUrl: string }
  seeded.push(body.key)
  return body
}

async function put(uploadUrl: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes })
  expect(res.status, await res.text()).toBe(200)
}

async function confirmedAt(key: string): Promise<Date | null | 'no-row'> {
  const r = await testDb().query<{ confirmed_at: Date | null }>(
    'SELECT confirmed_at FROM uploads WHERE s3_key = $1',
    [key]
  )
  const row = r.rows[0]
  return row ? row.confirmed_at : 'no-row'
}

describe('POST /api/upload/confirm', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterEach(async () => {
    for (const key of seeded.splice(0)) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {})
    }
  })

  it('rejects anonymous with 401', async () => {
    const res = await anonClient().post('/api/upload/confirm', { key: 'docs/x/y.png' })
    expect(res.status).toBe(401)
  })

  it.each([
    'backups/postgres/x.sql.gz.gpg',
    'workspaces/ws12345678/knowledge/abcdefghijkl.pdf'
  ])('404s a key outside the issued shape (%s) and never touches the object', async (key) => {
    const user = await createUser()
    await seed(key, new Uint8Array([1, 2, 3]))
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/upload/confirm', { key })
    expect(res.status).toBe(404)
    expect(await exists(key)).toBe(true)
  })

  it('404s a well-shaped key that was never issued, leaving the object intact', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'open-edit' })
    const key = `docs/${doc.docId}/AAAAAAAAAAAA.png`
    await seed(key, new Uint8Array([1, 2, 3]))
    const client = await loggedInClient(user.id)
    const res = await client.post('/api/upload/confirm', { key })
    expect(res.status).toBe(404)
    expect(await exists(key)).toBe(true)
  })

  it('404s another user\'s pending key, leaving object and row untouched', async () => {
    const alice = await createUser()
    const mallory = await createUser()
    const doc = await createDoc({ ownerId: alice.id, accessMode: 'open-edit' })
    const { key, uploadUrl } = await requestUpload(alice.id, doc.docId)
    await put(uploadUrl, PNG)

    const client = await loggedInClient(mallory.id)
    const res = await client.post('/api/upload/confirm', { key })
    expect(res.status).toBe(404)
    expect(await exists(key)).toBe(true)
    expect(await confirmedAt(key)).toBeNull()
  })

  it('confirms the caller\'s own valid image', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const { key, uploadUrl } = await requestUpload(user.id, doc.docId)
    await put(uploadUrl, PNG)

    const client = await loggedInClient(user.id)
    const res = await client.post('/api/upload/confirm', { key })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean, size: number }
    expect(body.success).toBe(true)
    expect(body.size).toBe(PNG.length)
    expect(await confirmedAt(key)).toBeInstanceOf(Date)
    expect(await exists(key)).toBe(true)
  })

  it('is idempotent: a second confirm succeeds and keeps the object', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const { key, uploadUrl } = await requestUpload(user.id, doc.docId)
    await put(uploadUrl, PNG)

    const client = await loggedInClient(user.id)
    expect((await client.post('/api/upload/confirm', { key })).status).toBe(200)
    const first = await confirmedAt(key)
    expect((await client.post('/api/upload/confirm', { key })).status).toBe(200)
    expect(await confirmedAt(key)).toEqual(first)
    expect(await exists(key)).toBe(true)
  })

  it('rejects and deletes the caller\'s own mismatched-content upload', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const { key, uploadUrl } = await requestUpload(user.id, doc.docId)
    // The presigned PUT binds Content-Length, so the fake payload matches the PNG's size.
    await put(uploadUrl, new TextEncoder().encode('<svg onload="alert(1)"></svg>'.padEnd(PNG.length, ' ')))

    const client = await loggedInClient(user.id)
    const res = await client.post('/api/upload/confirm', { key })
    expect(res.status).toBe(415)
    expect(await exists(key)).toBe(false)
    expect(await confirmedAt(key)).toBe('no-row')
  })

  // Regression: the presigned PUT did not bind Content-Type, so a valid
  // PNG could be stored as `text/html` and served back as a document.
  it('the presigned PUT refuses a Content-Type other than the requested one', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const { key, uploadUrl } = await requestUpload(user.id, doc.docId)
    expect(new URL(uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toContain('content-type')
    const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: PNG })
    expect(res.status).toBe(403)
    expect(await exists(key)).toBe(false)
  })

  it('rejects and deletes an object whose stored Content-Type is not the requested image type', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const { key } = await requestUpload(user.id, doc.docId)
    // Simulates an object that reached the key with a different stored
    // type (e.g. uploaded before the type was signed).
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: PNG, ContentType: 'text/html' }))

    const client = await loggedInClient(user.id)
    const res = await client.post('/api/upload/confirm', { key })
    expect(res.status).toBe(415)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('upload/content-type-mismatch')
    expect(await exists(key)).toBe(false)
    expect(await confirmedAt(key)).toBe('no-row')
  })

  it('403s when write access was lost between request and confirm', async () => {
    const owner = await createUser()
    const other = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const { key, uploadUrl } = await requestUpload(other.id, doc.docId)
    await put(uploadUrl, PNG)
    await testDb().query('UPDATE documents SET access_mode = \'private\' WHERE doc_id = $1', [doc.docId])

    const client = await loggedInClient(other.id)
    const res = await client.post('/api/upload/confirm', { key })
    expect(res.status).toBe(403)
    expect(await exists(key)).toBe(true)
  })
})
