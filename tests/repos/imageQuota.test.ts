import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  confirmOwnUploadWithinQuota,
  insertConfirmedUploadsWithinQuota,
  recordPending,
  reservePendingUpload,
  sumImageBytesByUploader,
  sumImageBytesInScope
} from '../../server/repos/uploads'
import { createDoc, createUser } from '../integration/setup/fixtures'

// Per-user image storage quota primitives. The headline property: the
// reservation is atomic per user, so a burst of parallel upload requests
// can't jointly overshoot the quota (each would otherwise read the same
// "used" sum before any of them inserted).

let seq = 0
function userScope(uploaderId: number) {
  return { kind: 'user' as const, uploaderId, excludePooled: false }
}
function pending(docId: string, uploaderId: number, sizeBytes: number) {
  seq++
  const fileId = `f${String(seq).padStart(11, '0')}.png`
  return { docId, fileId, uploaderId, contentType: 'image/png', sizeBytes, s3Key: `docs/${docId}/${fileId}` }
}

describe('image storage quota (uploads repo)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('sums pending and confirmed rows of the uploader only', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const doc = await createDoc({ ownerId: alice.id, accessMode: 'open-edit' })
    await recordPending(pending(doc.docId, alice.id, 100))
    const confirmed = pending(doc.docId, alice.id, 250)
    await recordPending(confirmed)
    await testDb().query('UPDATE uploads SET confirmed_at = now() WHERE s3_key = $1', [confirmed.s3Key])
    await recordPending(pending(doc.docId, bob.id, 9999))

    expect(await sumImageBytesByUploader(alice.id)).toBe(350)
    expect(await sumImageBytesByUploader(bob.id)).toBe(9999)
  })

  it('admits exactly what fits out of a parallel burst of reservations', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reservePendingUpload(pending(doc.docId, user.id, 100), 1000, userScope(user.id)))
    )
    expect(results.filter(r => r.reserved)).toHaveLength(10)
    expect(await sumImageBytesByUploader(user.id)).toBe(1000)
  })

  it('refuses a single reservation larger than the remaining quota', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    expect((await reservePendingUpload(pending(doc.docId, user.id, 600), 1000, userScope(user.id))).reserved).toBe(true)
    const second = await reservePendingUpload(pending(doc.docId, user.id, 500), 1000, userScope(user.id))
    expect(second).toEqual({ reserved: false, usedBytes: 600 })
    expect(await sumImageBytesByUploader(user.id)).toBe(600)
  })

  it('confirm flips a reserved row, is idempotent, and refuses when the user is over quota now', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    const a = pending(doc.docId, user.id, 400)
    const b = pending(doc.docId, user.id, 400)
    await recordPending(a)
    await recordPending(b)

    expect(await confirmOwnUploadWithinQuota(a.s3Key, user.id, 1000, userScope(user.id))).toBe('confirmed')
    expect(await confirmOwnUploadWithinQuota(a.s3Key, user.id, 1000, userScope(user.id))).toBe('already-confirmed')
    // The quota was lowered below what is already held.
    expect(await confirmOwnUploadWithinQuota(b.s3Key, user.id, 500, userScope(user.id))).toBe('over-quota')
    const row = await testDb().query<{ confirmed_at: Date | null }>('SELECT confirmed_at FROM uploads WHERE s3_key = $1', [b.s3Key])
    expect(row.rows[0]?.confirmed_at).toBeNull()
    // Someone else's key is never confirmed.
    const other = await createUser()
    expect(await confirmOwnUploadWithinQuota(b.s3Key, other.id, 10_000, userScope(other.id))).toBe('missing')
  })

  it('inserts duplicated copies only when they fit, attributed to the given user', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id })
    await recordPending(pending(doc.docId, user.id, 700))
    const rows = [pending(doc.docId, user.id, 200), pending(doc.docId, user.id, 200)]

    expect((await insertConfirmedUploadsWithinQuota(rows, 1000, userScope(user.id))).reserved).toBe(false)
    expect(await sumImageBytesByUploader(user.id)).toBe(700)

    expect((await insertConfirmedUploadsWithinQuota(rows, 1100, userScope(user.id))).reserved).toBe(true)
    expect(await sumImageBytesByUploader(user.id)).toBe(1100)
    const confirmed = await testDb().query<{ c: string }>(
      'SELECT count(*) AS c FROM uploads WHERE uploader_id = $1 AND confirmed_at IS NOT NULL', [user.id]
    )
    expect(Number(confirmed.rows[0]?.c)).toBe(2)
  })
})

describe('pooled image storage (Team / Business workspaces)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function pooledWorkspace(ownerId: number, status = 'active'): Promise<string> {
    const workspaceId = `ws-pool-${++seq}`
    await testDb().query('INSERT INTO workspaces (workspace_id, owner_id, name) VALUES ($1, $2, $3)', [workspaceId, ownerId, 'Pool'])
    await testDb().query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, valid_until)
       VALUES ($1, 'team', 3, $2, now() + interval '30 days')`,
      [workspaceId, status]
    )
    return workspaceId
  }

  it('workspace scope sums every uploader in the workspace\'s docs; personal sums leave pooled docs out', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const wsId = await pooledWorkspace(alice.id)
    const wsDoc = await createDoc({ ownerId: alice.id, workspaceId: wsId })
    const personalDoc = await createDoc({ ownerId: alice.id })
    await recordPending(pending(wsDoc.docId, alice.id, 300))
    await recordPending(pending(wsDoc.docId, bob.id, 200))
    await recordPending(pending(personalDoc.docId, alice.id, 50))

    expect(await sumImageBytesInScope({ kind: 'workspace', workspaceId: wsId })).toBe(500)
    expect(await sumImageBytesByUploader(alice.id, { excludePooled: true })).toBe(50)
    expect(await sumImageBytesByUploader(alice.id)).toBe(350)
    expect(await sumImageBytesByUploader(bob.id, { excludePooled: true })).toBe(0)
  })

  it('a lapsed subscription stops pooling: the images count per user again', async () => {
    const alice = await createUser()
    const wsId = await pooledWorkspace(alice.id, 'canceled')
    const wsDoc = await createDoc({ ownerId: alice.id, workspaceId: wsId })
    await recordPending(pending(wsDoc.docId, alice.id, 300))
    expect(await sumImageBytesByUploader(alice.id, { excludePooled: true })).toBe(300)
  })

  it('reservations in a workspace scope are atomic across uploaders', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const wsId = await pooledWorkspace(alice.id)
    const doc = await createDoc({ ownerId: alice.id, workspaceId: wsId })
    const scope = { kind: 'workspace' as const, workspaceId: wsId }
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      reservePendingUpload(pending(doc.docId, i % 2 === 0 ? alice.id : bob.id, 100), 1000, scope)))
    expect(results.filter(r => r.reserved)).toHaveLength(10)
    expect(await sumImageBytesInScope(scope)).toBe(1000)
  })
})
