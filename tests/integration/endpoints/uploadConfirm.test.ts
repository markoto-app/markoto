import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { DEFAULT_TIERS as TIERS } from '../../../shared/config/tiers'

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

async function seed(key: string, body: Uint8Array, contentType?: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }))
  seeded.push(key)
}

/** Where the presigned PUT lands (confirm copies it to `key`). */
function staging(key: string): string {
  const slash = key.lastIndexOf('/')
  return `${key.slice(0, slash)}/staging${key.slice(slash)}`
}

async function read(key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  if (!res.Body) throw new Error(`no body for ${key}`)
  return await res.Body.transformToByteArray()
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
  seeded.push(body.key, staging(body.key))
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
    expect(await exists(staging(key))).toBe(true)
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
    await seed(staging(key), PNG, 'text/html')

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
    // Untouched: the upload is still where the PUT left it.
    expect(await exists(staging(key))).toBe(true)
  })
})

// Regression (presigned PUT re-use): the URL stayed valid for its whole
// lifetime and targeted the served key, so after confirm had sniffed the
// bytes the uploader could PUT again (same length + type) and swap the
// confirmed image for arbitrary bytes.
describe('POST /api/upload/confirm — confirmed images are immutable', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterEach(async () => {
    for (const key of seeded.splice(0)) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {})
    }
  })

  it('the presigned URL writes a staging key, never the served key, and lives at most 120 s', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const { key, uploadUrl } = await requestUpload(user.id, doc.docId)
    const url = new URL(uploadUrl)
    expect(url.pathname.endsWith(`/${BUCKET}/${key}`)).toBe(false)
    expect(url.pathname.endsWith(`/${BUCKET}/${staging(key)}`)).toBe(true)
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(120)
  })

  it('re-using the URL after confirm cannot change the served bytes', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const { key, uploadUrl } = await requestUpload(user.id, doc.docId)
    await put(uploadUrl, PNG)
    const client = await loggedInClient(user.id)
    expect((await client.post('/api/upload/confirm', { key })).status).toBe(200)
    expect(await exists(staging(key))).toBe(false)

    // Same length + signed type, different bytes.
    const swapped = new TextEncoder().encode('<svg onload="alert(1)"></svg>'.padEnd(PNG.length, ' '))
    await put(uploadUrl, swapped)

    expect(Buffer.from(await read(key)).equals(Buffer.from(PNG))).toBe(true)
  })

  it('rejects a staging object whose size differs from the requested one', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const { key } = await requestUpload(user.id, doc.docId)
    const bigger = new Uint8Array(PNG.length + 10)
    bigger.set(PNG)
    await seed(staging(key), bigger, 'image/png')

    const client = await loggedInClient(user.id)
    const res = await client.post('/api/upload/confirm', { key })
    expect(res.status).toBe(400)
    expect(await exists(key)).toBe(false)
    expect(await exists(staging(key))).toBe(false)
    expect(await confirmedAt(key)).toBe('no-row')
  })
})

// Regression (storage abuse): there was no per-user image quota — any
// signed-in user could store 60 × 10 MB per minute, forever.
describe('image storage quota', () => {
  const TEN_MB = 10 * 1024 * 1024

  beforeEach(async () => {
    await resetDb()
  })

  afterEach(async () => {
    for (const key of seeded.splice(0)) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {})
    }
  })

  async function requestSized(userId: number, docId: string, size: number) {
    const client = await loggedInClient(userId)
    return client.post('/api/upload/request', { docId, filename: 'big.png', contentType: 'image/png', size })
  }

  it('reserves at request time: a parallel burst cannot overshoot the free quota', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const fits = Math.floor(TIERS.free.imageBytesPerUser / TEN_MB)
    const results = await Promise.all(
      Array.from({ length: fits + 3 }, () => requestSized(user.id, doc.docId, TEN_MB))
    )
    const ok = results.filter(r => r.status === 200)
    const refused = results.filter(r => r.status === 409)
    expect(ok).toHaveLength(fits)
    expect(refused).toHaveLength(3)
    const first = refused[0]
    if (!first) throw new Error('expected a refused request')
    const body = await first.json() as { data?: { code?: string, messageKey?: string } }
    expect(body.data?.code).toBe('upload/storage-quota')
    expect(body.data?.messageKey).toBe('image.storageQuotaReached')

    const usage = await (await loggedInClient(user.id)).get('/api/user/billing')
    const billing = await usage.json() as { imageBytesUsed: number, imageBytesPerUserLimit: number }
    expect(billing.imageBytesUsed).toBe(fits * TEN_MB)
    expect(billing.imageBytesPerUserLimit).toBe(TIERS.free.imageBytesPerUser)
  })

  it('confirm refuses (and cleans up) when the user is over quota now', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    // On a paid plan the reservations fit; then the plan lapses.
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await testDb().query('UPDATE users SET plan = \'pro\', plan_valid_until = $1 WHERE id = $2', [future, user.id])
    const fits = Math.floor(TIERS.free.imageBytesPerUser / TEN_MB)
    for (let i = 0; i < fits; i++) expect((await requestSized(user.id, doc.docId, TEN_MB)).status).toBe(200)
    const { key, uploadUrl } = await requestUpload(user.id, doc.docId)
    await put(uploadUrl, PNG)
    await testDb().query('UPDATE users SET plan = \'free\', plan_valid_until = NULL WHERE id = $1', [user.id])

    const res = await (await loggedInClient(user.id)).post('/api/upload/confirm', { key })
    expect(res.status).toBe(409)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('upload/storage-quota')
    expect(await confirmedAt(key)).toBe('no-row')
    expect(await exists(key)).toBe(false)
    expect(await exists(staging(key))).toBe(false)
  })
})
