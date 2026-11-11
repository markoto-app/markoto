import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  hasUserAiSession,
  addAiSession,
  removeAiSession,
  getAiSession,
  snapshotAiSessions,
  purgeStaleAiSessions,
  DuplicateSessionError
} from '../../server/utils/ai/aiSessions'
import { createUser, createDoc as seedDoc } from '../integration/setup/fixtures'

// AI session registry. Enforces the "one AI per user per doc" cap via
// a Postgres UNIQUE index; tests verify the index actually guards the
// insert path, and that the local AbortController map is kept in sync
// with the DB rows.

async function sessionRowCount(): Promise<number> {
  const db = testDb()
  const r = await db.query<{ c: string }>('SELECT COUNT(*) AS c FROM ai_sessions')
  return Number(r.rows[0].c)
}

function makeEntry(overrides: Partial<Parameters<typeof addAiSession>[0]> = {}): Parameters<typeof addAiSession>[0] {
  return {
    sessionId: 'sess-1',
    docId: 'doc-1',
    initiatorUserId: 42,
    initiatorName: 'Alice',
    initiatorColor: '#d97706',
    startedAt: new Date(),
    abortController: new AbortController(),
    ...overrides
  }
}

describe('addAiSession / getAiSession', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('round-trips a session through the registry', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await addAiSession(makeEntry({ sessionId: 'sess-rt', docId: doc.docId, initiatorUserId: user.id }))
    const got = await getAiSession('sess-rt')
    expect(got).not.toBeUndefined()
    expect(got!.sessionId).toBe('sess-rt')
    expect(got!.docId).toBe(doc.docId)
    expect(got!.initiatorUserId).toBe(user.id)
    expect(got!.initiatorName).toBe('Alice')
    expect(got!.initiatorColor).toBe('#d97706')
    // The local AbortController is attached on add.
    expect(got!.abortController).toBeInstanceOf(AbortController)
  })

  it('getAiSession returns undefined for unknown sessionId', async () => {
    expect(await getAiSession('does-not-exist')).toBeUndefined()
  })

  it('hasUserAiSession is false when the user has no session on this doc', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    expect(await hasUserAiSession(user.id, doc.docId)).toBe(false)
  })

  it('hasUserAiSession becomes true after addAiSession', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await addAiSession(makeEntry({ sessionId: 'sess-h', docId: doc.docId, initiatorUserId: user.id }))
    expect(await hasUserAiSession(user.id, doc.docId)).toBe(true)
  })
})

describe('per-user-per-doc UNIQUE cap', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('second addAiSession for the same (user, doc) throws DuplicateSessionError', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await addAiSession(makeEntry({ sessionId: 'first', docId: doc.docId, initiatorUserId: user.id }))
    await expect(
      addAiSession(makeEntry({ sessionId: 'second', docId: doc.docId, initiatorUserId: user.id }))
    ).rejects.toBeInstanceOf(DuplicateSessionError)
    // The DB row count stays at 1.
    expect(await sessionRowCount()).toBe(1)
  })

  it('same user on DIFFERENT docs: both allowed', async () => {
    const user = await createUser()
    const docA = await seedDoc({ ownerId: user.id })
    const docB = await seedDoc({ ownerId: user.id })
    await addAiSession(makeEntry({ sessionId: 'a', docId: docA.docId, initiatorUserId: user.id }))
    await addAiSession(makeEntry({ sessionId: 'b', docId: docB.docId, initiatorUserId: user.id }))
    expect(await sessionRowCount()).toBe(2)
  })

  it('different users on the SAME doc: both allowed', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const doc = await seedDoc({ ownerId: alice.id })
    await addAiSession(makeEntry({ sessionId: 'a', docId: doc.docId, initiatorUserId: alice.id }))
    await addAiSession(makeEntry({ sessionId: 'b', docId: doc.docId, initiatorUserId: bob.id }))
    expect(await sessionRowCount()).toBe(2)
  })

  it('concurrent adds for the same (user, doc): exactly one wins', async () => {
    // Race target — the UNIQUE index is the serialization point. Two
    // near-simultaneous /api/ai/prompt calls from the same user on the
    // same doc must land in exactly one DB row + one DuplicateSessionError.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const results = await Promise.allSettled([
      addAiSession(makeEntry({ sessionId: 'p1', docId: doc.docId, initiatorUserId: user.id })),
      addAiSession(makeEntry({ sessionId: 'p2', docId: doc.docId, initiatorUserId: user.id }))
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled').length
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toBe(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateSessionError)
    expect(await sessionRowCount()).toBe(1)
  })

  it('after removeAiSession, the user can start a fresh session', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await addAiSession(makeEntry({ sessionId: 'sess-1', docId: doc.docId, initiatorUserId: user.id }))
    await removeAiSession('sess-1')
    // Fresh start must succeed.
    await addAiSession(makeEntry({ sessionId: 'sess-2', docId: doc.docId, initiatorUserId: user.id }))
    expect(await hasUserAiSession(user.id, doc.docId)).toBe(true)
    expect(await sessionRowCount()).toBe(1)
  })
})

describe('removeAiSession', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes the DB row AND the local AbortController', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await addAiSession(makeEntry({ sessionId: 'sess-rm', docId: doc.docId, initiatorUserId: user.id }))
    await removeAiSession('sess-rm')
    expect(await getAiSession('sess-rm')).toBeUndefined()
    expect(await hasUserAiSession(user.id, doc.docId)).toBe(false)
    expect(await sessionRowCount()).toBe(0)
  })

  it('is a no-op for an unknown sessionId', async () => {
    await expect(removeAiSession('ghost')).resolves.toBeUndefined()
  })
})

describe('abortController lifecycle', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('sessions added in this process have a local AbortController attached', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const ctrl = new AbortController()
    await addAiSession(makeEntry({
      sessionId: 's-local', docId: doc.docId, initiatorUserId: user.id, abortController: ctrl
    }))
    const got = await getAiSession('s-local')
    expect(got!.abortController).toBe(ctrl)
  })

  it('sessions not started in this process: abortController is null', async () => {
    // Multi-process story: if /api/ai/abort lands on a different Nitro
    // worker than the one running the loop, the DB row exists but no
    // local controller. Simulate by inserting a row directly.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    const db = testDb()
    await db.query(
      `INSERT INTO ai_sessions (session_id, doc_id, initiator_user_id, initiator_name, initiator_color)
       VALUES ('foreign', $1, $2, 'X', '#000')`,
      [doc.docId, user.id]
    )
    const got = await getAiSession('foreign')
    expect(got).not.toBeUndefined()
    expect(got!.abortController).toBeNull()
  })
})

describe('snapshotAiSessions', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns every registered session', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const doc = await seedDoc({ ownerId: alice.id })
    await addAiSession(makeEntry({ sessionId: 'a', docId: doc.docId, initiatorUserId: alice.id }))
    await addAiSession(makeEntry({ sessionId: 'b', docId: doc.docId, initiatorUserId: bob.id }))
    const snap = await snapshotAiSessions()
    expect(snap.map(s => s.sessionId).sort()).toEqual(['a', 'b'])
  })

  it('populates abortController for local entries, null for foreign', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const doc = await seedDoc({ ownerId: alice.id })
    // Alice's session is started IN this process (has a local controller).
    await addAiSession(makeEntry({ sessionId: 'local', docId: doc.docId, initiatorUserId: alice.id }))
    // Bob's session is simulated to have been started on another Nitro
    // worker — DB row exists but no local controller in this process.
    const db = testDb()
    await db.query(
      `INSERT INTO ai_sessions (session_id, doc_id, initiator_user_id, initiator_name, initiator_color)
       VALUES ('foreign', $1, $2, 'Bob', '#000')`,
      [doc.docId, bob.id]
    )
    const snap = await snapshotAiSessions()
    const byId = new Map(snap.map(s => [s.sessionId, s]))
    expect(byId.get('local')?.abortController).toBeInstanceOf(AbortController)
    expect(byId.get('foreign')?.abortController).toBeNull()
  })
})

describe('purgeStaleAiSessions', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function setStartedAt(sessionId: string, d: Date): Promise<void> {
    const db = testDb()
    await db.query('UPDATE ai_sessions SET started_at = $1 WHERE session_id = $2', [d, sessionId])
  }

  it('deletes sessions whose startedAt is older than the threshold', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await addAiSession(makeEntry({ sessionId: 'old', docId: doc.docId, initiatorUserId: user.id }))
    await setStartedAt('old', new Date(Date.now() - 10 * 60_000))
    const deleted = await purgeStaleAiSessions(7 * 60_000)
    expect(deleted).toBe(1)
    expect(await sessionRowCount()).toBe(0)
  })

  it('leaves fresh sessions alone', async () => {
    // Regression target: the server/utils/agentic/AGENTS.md invariant is "sweep threshold
    // must exceed prompt deadline" — the 7-min sweeper can't kill a
    // legit 5-min session that's still running. Simulate: add a
    // session at startedAt=now, then purge with a 7-min threshold.
    // Nothing should be deleted.
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    await addAiSession(makeEntry({ sessionId: 'fresh', docId: doc.docId, initiatorUserId: user.id }))
    const deleted = await purgeStaleAiSessions(7 * 60_000)
    expect(deleted).toBe(0)
    expect(await sessionRowCount()).toBe(1)
  })

  it('only deletes sessions past the threshold, leaves ones just inside it', async () => {
    const user = await createUser()
    const doc = await seedDoc({ ownerId: user.id })
    // Session at exactly threshold-minus-1s → still alive.
    await addAiSession(makeEntry({ sessionId: 'borderline', docId: doc.docId, initiatorUserId: user.id }))
    await setStartedAt('borderline', new Date(Date.now() - (7 * 60_000 - 1000)))
    const deleted = await purgeStaleAiSessions(7 * 60_000)
    expect(deleted).toBe(0)
  })

  it('returns 0 when nothing to purge (idle sweeper case)', async () => {
    expect(await purgeStaleAiSessions(7 * 60_000)).toBe(0)
  })
})
