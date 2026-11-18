import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser } from '../integration/setup/fixtures'
import { appendYjsUpdate, readAllYjsUpdates } from '../../server/repos/yjsLog'
import { docAs } from '../helpers/access'

// Renaming a document from the explorer: the row first, then the live
// Y.Doc title through a short sync connection as the renaming user, and,
// when the sync server can't be reached, an update appended to the stored
// log that wins over the stored title. The sync server is replaced by a
// fake provider here (tests/integration/sync covers the real one).

type Mode = 'ok' | 'auth-failed'
const fake = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'auth-failed',
  token: '' as string,
  url: '' as string,
  liveTitle: undefined as unknown,
  destroyed: 0
}))

vi.mock('@hocuspocus/provider', () => {
  class FakeProvider {
    hasUnsyncedChanges = false
    private listeners = new Map<string, Set<() => void>>()
    constructor(opts: { url: string, token: string, document: Y.Doc, onSynced: () => void, onAuthenticationFailed: () => void }) {
      fake.token = opts.token
      fake.url = opts.url
      opts.document.on('update', () => {
        fake.liveTitle = opts.document.getMap('meta').get('title')
        this.hasUnsyncedChanges = true
        if (fake.mode === 'ok') {
          setTimeout(() => {
            this.hasUnsyncedChanges = false
            for (const l of this.listeners.get('unsyncedChanges') ?? []) l()
          }, 5)
        }
      })
      setTimeout(() => (fake.mode === 'auth-failed' ? opts.onAuthenticationFailed() : opts.onSynced()), 1)
    }

    on(event: string, fn: () => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set())
      this.listeners.get(event)!.add(fn)
    }

    off(event: string, fn: () => void) {
      this.listeners.get(event)?.delete(fn)
    }

    disconnect() {}
    destroy() {
      fake.destroyed++
    }
  }
  return { HocuspocusProvider: FakeProvider }
})

const { renameDocument } = await import('../../server/utils/documents/liveTitle')

function reset(mode: Mode) {
  fake.mode = mode
  fake.token = ''
  fake.url = ''
  fake.liveTitle = undefined
  fake.destroyed = 0
}

async function rowTitle(docId: string): Promise<string | undefined> {
  return (await testDb().query<{ title: string }>('SELECT title FROM documents WHERE doc_id = $1', [docId])).rows[0]?.title
}

/** The title the stored log replays to. */
async function storedTitle(docId: string): Promise<unknown> {
  const ydoc = new Y.Doc()
  for (const u of await readAllYjsUpdates(docAs(docId))) Y.applyUpdate(ydoc, u)
  return ydoc.getMap('meta').get('title')
}

describe('renameDocument', () => {
  beforeEach(resetDb)

  it('writes the row and the live title as the renaming user', async () => {
    reset('ok')
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id })
    const res = await renameDocument(docAs(doc.docId, alice.id), 'Quarterly plan', { userId: alice.id, userName: 'Alice' })

    expect(res).toEqual({ live: true })
    expect(await rowTitle(doc.docId)).toBe('Quarterly plan')
    expect(fake.liveTitle).toBe('Quarterly plan')
    expect(fake.url).toMatch(/^wss?:\/\//)
    expect(jwt.decode(fake.token)).toMatchObject({ docId: doc.docId, userId: String(alice.id), userName: 'Alice', readOnly: false })
    expect(fake.destroyed).toBe(1)
    // The live path leaves the stored log to the sync server.
    expect(await readAllYjsUpdates(docAs(doc.docId))).toHaveLength(0)
  })

  it('falls back to the stored log when the sync server refuses, and the new title wins over the stored one', async () => {
    reset('auth-failed')
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id })
    const before = new Y.Doc()
    before.getMap('meta').set('title', 'Old title')
    before.getText('content').insert(0, '# Body stays')
    await appendYjsUpdate(docAs(doc.docId), Y.encodeStateAsUpdate(before))

    const res = await renameDocument(docAs(doc.docId, alice.id), 'New title', { userId: alice.id, userName: 'Alice' })
    expect(res).toEqual({ live: false })
    expect(await rowTitle(doc.docId)).toBe('New title')
    expect(await storedTitle(doc.docId)).toBe('New title')

    const replay = new Y.Doc()
    for (const u of await readAllYjsUpdates(docAs(doc.docId))) Y.applyUpdate(replay, u)
    expect(replay.getText('content').toString()).toBe('# Body stays')
  })

  it('clamps an overlong title in the Y.Doc', async () => {
    reset('auth-failed')
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id })
    await renameDocument(docAs(doc.docId, alice.id), 'x'.repeat(5000), { userId: alice.id, userName: 'Alice' })
    const stored = await storedTitle(doc.docId)
    expect(typeof stored).toBe('string')
    expect((stored as string).length).toBeLessThan(5000)
  })

  it('skips an unreadable stored row when it appends the title', async () => {
    reset('auth-failed')
    const alice = await createUser()
    const doc = await createDoc({ ownerId: alice.id })
    // A corrupt stored row is skipped on replay, as on load.
    await testDb().query(`INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', '\\x00ff'::bytea)`, [doc.docId])
    const res = await renameDocument(docAs(doc.docId, alice.id), 'Still renamed', { userId: alice.id, userName: 'Alice' })
    expect(res.live).toBe(false)
    expect(await rowTitle(doc.docId)).toBe('Still renamed')
    const rows = await readAllYjsUpdates(docAs(doc.docId))
    expect(rows).toHaveLength(2)
    const appended = new Y.Doc()
    Y.applyUpdate(appended, rows[1]!)
    expect(appended.getMap('meta').get('title')).toBe('Still renamed')
  })
})
