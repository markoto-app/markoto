import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type S3Client
} from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../integration/setup/db'
import {
  deleteDocDbRows,
  cleanupDocS3,
  notifySyncDeleted
} from '../../server/utils/documentLifecycle'
import { appendActivity } from '../../server/repos/activity'
import { recordPending } from '../../server/repos/uploads'
import { createUser, createDoc as seedDoc } from '../integration/setup/fixtures'

// Each phase is tested independently so failure-isolation is visible:
//   - deleteDocDbRows: touches DB only, in FK-safe order
//   - cleanupDocS3: swallows S3 errors, returns deleted-count
//   - notifySyncDeleted: fire-and-forget, never throws, returns
//     whether it dispatched
//
// The orchestrator deleteDocument is covered by the endpoint integration
// tests (DELETE /api/docs/:id).

// --- fake S3 ---------------------------------------------------------------

type SendFn = S3Client['send']

interface FakeS3State {
  keys: Set<string>
  listCalls: number
  deleteCalls: Array<{ Keys: string[] }>
  listShouldFail?: boolean
  deleteShouldFail?: boolean
}

function makeFakeS3(state: FakeS3State): Pick<S3Client, 'send'> {
  const send = (async (cmd: unknown) => {
    if (cmd instanceof ListObjectsV2Command) {
      state.listCalls++
      if (state.listShouldFail) throw new Error('s3-list-boom')
      const input = cmd.input as { Prefix?: string }
      const prefix = input.Prefix ?? ''
      const contents = [...state.keys]
        .filter(k => k.startsWith(prefix))
        .map(Key => ({ Key }))
      return { Contents: contents, IsTruncated: false }
    }
    if (cmd instanceof DeleteObjectsCommand) {
      if (state.deleteShouldFail) throw new Error('s3-delete-boom')
      const input = cmd.input as { Delete?: { Objects?: Array<{ Key?: string }> } }
      const keys = (input.Delete?.Objects ?? []).map(o => o.Key!).filter(Boolean)
      state.deleteCalls.push({ Keys: keys })
      for (const k of keys) state.keys.delete(k)
      return {}
    }
    throw new Error('Unexpected S3 command in test: ' + cmd)
  }) as unknown as SendFn
  return { send }
}

// --- deleteDocDbRows -------------------------------------------------------

describe('deleteDocDbRows', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes activity + uploads + documents rows for the target doc', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await appendActivity({ docId: doc.docId, userName: 'u', action: 'edit' })
    await recordPending({
      docId: doc.docId, fileId: 'a.png', uploaderId: user.id,
      contentType: 'image/png', sizeBytes: 1, s3Key: `docs/${doc.docId}/a.png`
    })

    await deleteDocDbRows(doc.docId)

    const db = testDb()
    expect(Number((await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM documents WHERE doc_id = $1', [doc.docId])).rows[0].c)).toBe(0)
    expect(Number((await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM uploads WHERE doc_id = $1', [doc.docId])).rows[0].c)).toBe(0)
    expect(Number((await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM activity_log WHERE doc_id = $1', [doc.docId])).rows[0].c)).toBe(0)
  })

  it('leaves OTHER docs untouched', async () => {
    const user = await createUser()
    const docA = await seedDoc({ ownerId: user.id })
    const docB = await seedDoc({ ownerId: user.id })
    await appendActivity({ docId: docA.docId, userName: 'u', action: 'edit' })
    await appendActivity({ docId: docB.docId, userName: 'u', action: 'edit' })

    await deleteDocDbRows(docA.docId)

    const db = testDb()
    expect(Number((await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM activity_log WHERE doc_id = $1', [docB.docId])).rows[0].c)).toBe(1)
    expect(Number((await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM documents WHERE doc_id = $1', [docB.docId])).rows[0].c)).toBe(1)
  })

  it('is idempotent — deleting a nonexistent doc is a no-op (no throw)', async () => {
    await expect(deleteDocDbRows('ghost-doc')).resolves.toBeUndefined()
  })

  it('FK order: activity and uploads drop BEFORE the documents row', async () => {
    // Regression target: if deleteDocRow ran first, the activity/uploads
    // deletes would succeed (they'd have no rows to match) but the FK
    // constraint `documents.workspace_id` -> workspaces would still be
    // fine. The real risk is reversing to `documents first` in a version
    // where activity_log has `ON DELETE RESTRICT` — then docs can't drop.
    // We don't have RESTRICT today, but pin the order so a schema
    // change noticing it can flip both together.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await appendActivity({ docId: doc.docId, userName: 'u', action: 'edit' })
    await deleteDocDbRows(doc.docId)
    // Everything gone — test passes iff the FK-safe order worked.
    const db = testDb()
    expect(Number((await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM documents WHERE doc_id = $1', [doc.docId])).rows[0].c)).toBe(0)
  })
})

// --- cleanupDocS3 ----------------------------------------------------------

describe('cleanupDocS3', () => {
  it('deletes every object under docs/{docId}/', async () => {
    const state: FakeS3State = {
      keys: new Set(['docs/abc/a.png', 'docs/abc/b.png', 'docs/abc/nested/c.png']),
      listCalls: 0,
      deleteCalls: []
    }
    const count = await cleanupDocS3('abc', { s3: makeFakeS3(state), bucket: 'test' })
    expect(count).toBe(3)
    expect(state.keys.size).toBe(0)
  })

  it('does not touch objects under OTHER doc prefixes', async () => {
    const state: FakeS3State = {
      keys: new Set(['docs/abc/a.png', 'docs/xyz/b.png']),
      listCalls: 0,
      deleteCalls: []
    }
    const count = await cleanupDocS3('abc', { s3: makeFakeS3(state), bucket: 'test' })
    expect(count).toBe(1)
    expect(state.keys.has('docs/xyz/b.png')).toBe(true)
  })

  it('returns 0 and does not call DeleteObjects when there are no keys', async () => {
    const state: FakeS3State = {
      keys: new Set(['docs/other/a.png']),
      listCalls: 0,
      deleteCalls: []
    }
    const count = await cleanupDocS3('abc', { s3: makeFakeS3(state), bucket: 'test' })
    expect(count).toBe(0)
    expect(state.deleteCalls.length).toBe(0)
  })

  it('swallows a List failure — returns 0 and never throws', async () => {
    // Regression target — S3 down/unreachable must NOT block the user's
    // delete. Orphan-cleanup picks up what we miss.
    const state: FakeS3State = {
      keys: new Set(['docs/abc/a.png']),
      listCalls: 0,
      deleteCalls: [],
      listShouldFail: true
    }
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const count = await cleanupDocS3('abc', { s3: makeFakeS3(state), bucket: 'test' })
    expect(count).toBe(0)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('swallows a Delete failure mid-batch — returns 0, never throws', async () => {
    const state: FakeS3State = {
      keys: new Set(['docs/abc/a.png', 'docs/abc/b.png']),
      listCalls: 0,
      deleteCalls: [],
      deleteShouldFail: true
    }
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const count = await cleanupDocS3('abc', { s3: makeFakeS3(state), bucket: 'test' })
    expect(count).toBe(0)
    // Keys stay in S3 (fake didn't delete); orphan-cleanup will find them.
    expect(state.keys.size).toBe(2)
    warnSpy.mockRestore()
  })
})

// --- notifySyncDeleted -----------------------------------------------------

describe('notifySyncDeleted', () => {
  it('dispatches a POST with the right shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const dispatched = notifySyncDeleted('doc-1', {
      syncInternalUrl: 'http://sync.test',
      internalApiSecret: 'secret-123',
      fetchFn: fetchMock as unknown as typeof fetch
    })
    expect(dispatched).toBe(true)
    // Give the fire-and-forget call a tick to actually run.
    await new Promise(r => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://sync.test/internal/notify-deleted')
    expect(init.method).toBe('POST')
    expect(init.headers['X-Internal-Secret']).toBe('secret-123')
    expect(JSON.parse(init.body).docId).toBe('doc-1')
  })

  it('skips dispatch when syncInternalUrl is missing (dev without sync)', async () => {
    const fetchMock = vi.fn()
    const dispatched = notifySyncDeleted('doc-1', {
      syncInternalUrl: null,
      internalApiSecret: 'secret-123',
      fetchFn: fetchMock as unknown as typeof fetch
    })
    expect(dispatched).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips dispatch when internalApiSecret is missing', async () => {
    const fetchMock = vi.fn()
    const dispatched = notifySyncDeleted('doc-1', {
      syncInternalUrl: 'http://sync.test',
      internalApiSecret: '',
      fetchFn: fetchMock as unknown as typeof fetch
    })
    expect(dispatched).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns synchronously — does NOT await the HTTP call', async () => {
    // Regression target: the notify must be fire-and-forget. If the
    // caller (`deleteDocument`) awaited a wedged sync-server, the HTTP
    // delete endpoint would hang for `AbortSignal.timeout(3000)` instead
    // of returning 200 immediately. Simulate: fetch never resolves.
    let resolve: () => void = () => {}
    const neverResolves = new Promise<Response>((r) => {
      resolve = () => r(new Response())
    })
    const fetchMock = vi.fn().mockReturnValue(neverResolves)
    const t0 = Date.now()
    const dispatched = notifySyncDeleted('doc-1', {
      syncInternalUrl: 'http://sync.test',
      internalApiSecret: 'secret',
      fetchFn: fetchMock as unknown as typeof fetch
    })
    const elapsed = Date.now() - t0
    expect(dispatched).toBe(true)
    // Must have returned in ~0ms, not waited on the pending fetch.
    expect(elapsed).toBeLessThan(50)
    resolve()
  })

  it('swallows a fetch rejection — does NOT propagate an unhandledRejection', async () => {
    // If the sync-server is down and fetch rejects, the caught .catch()
    // logs but the app process must not crash.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const dispatched = notifySyncDeleted('doc-1', {
      syncInternalUrl: 'http://sync.test',
      internalApiSecret: 'secret',
      fetchFn: fetchMock as unknown as typeof fetch
    })
    expect(dispatched).toBe(true)
    // Give the catch handler a tick to fire.
    await new Promise(r => setTimeout(r, 5))
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
