import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  appendActivity,
  searchActivity,
  type ActivityAction,
  type ActivityMetadata
} from '../../server/repos/activity'
import { createUser, createDoc } from '../integration/setup/fixtures'
import { first } from '../helpers/assert'

// `search_activity_log` AI tool's repo path. Tests pin the filter
// composition rules + doc-scoped isolation that the per-prompt
// agentic loop relies on.

async function setRowTime(activityId: number, when: Date): Promise<void> {
  // Backdate a row so the (since, before) windowing tests are
  // deterministic. The repo always inserts with default `now()`.
  const db = testDb()
  await db.query('UPDATE activity_log SET created_at = $1 WHERE id = $2', [when, activityId])
}

async function getLastActivityId(): Promise<number> {
  const db = testDb()
  const r = await db.query<{ id: number }>(
    'SELECT id FROM activity_log ORDER BY id DESC LIMIT 1'
  )
  return first(r.rows).id
}

async function append(
  docId: string,
  action: ActivityAction,
  opts: {
    userName?: string | null
    metadata?: ActivityMetadata | null
    minutesAgo?: number
  } = {}
): Promise<number> {
  await appendActivity({
    docId,
    userName: opts.userName ?? 'Tester',
    action,
    metadata: opts.metadata ?? null
  })
  const id = await getLastActivityId()
  if (typeof opts.minutesAgo === 'number') {
    await setRowTime(id, new Date(Date.now() - opts.minutesAgo * 60_000))
  }
  return id
}

describe('searchActivity', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns most-recent rows when no filters are provided', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit', { minutesAgo: 30 })
    await append(doc.docId, 'theme.changed', { metadata: { kind: 'theme.changed' }, minutesAgo: 10 })
    await append(doc.docId, 'comment.added', {
      metadata: { kind: 'comment.added', commentId: 'c1', bodyPreview: 'hi' },
      minutesAgo: 1
    })

    const rows = await searchActivity(doc.docId)
    expect(rows.map(r => r.action)).toEqual(['comment.added', 'theme.changed', 'edit'])
  })

  it('respects the `actions` filter', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit')
    await append(doc.docId, 'theme.changed', { metadata: { kind: 'theme.changed' } })
    await append(doc.docId, 'comment.added', {
      metadata: { kind: 'comment.added', commentId: 'c1', bodyPreview: 'b' }
    })
    await append(doc.docId, 'restore', {
      metadata: { kind: 'restore', restoredFromActivityId: 1, restoredFromTime: '2026-04-30T00:00:00Z' }
    })

    const rows = await searchActivity(doc.docId, { actions: ['edit', 'restore'] })
    expect(rows.map(r => r.action).sort()).toEqual(['edit', 'restore'])
  })

  it('respects the `since` time bound', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit', { minutesAgo: 60 * 24 * 3 }) // 3 days ago
    await append(doc.docId, 'edit', { minutesAgo: 60 * 24 }) // 1 day ago
    await append(doc.docId, 'edit', { minutesAgo: 30 }) // 30 min ago

    const since = new Date(Date.now() - 60 * 60 * 1000) // 1 hour
    const rows = await searchActivity(doc.docId, { since })
    expect(rows).toHaveLength(1)
  })

  it('respects the `before` time bound', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit', { minutesAgo: 60 * 24 * 3 })
    await append(doc.docId, 'edit', { minutesAgo: 60 * 24 })
    await append(doc.docId, 'edit', { minutesAgo: 30 })

    const before = new Date(Date.now() - 60 * 60 * 1000) // 1 hour
    const rows = await searchActivity(doc.docId, { before })
    expect(rows).toHaveLength(2)
  })

  it('matches `query` against jsonb metadata via ILIKE', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'comment.added', {
      metadata: { kind: 'comment.added', commentId: 'c1', bodyPreview: 'pricing model needs work' }
    })
    await append(doc.docId, 'comment.added', {
      metadata: { kind: 'comment.added', commentId: 'c2', bodyPreview: 'introduction is fine' }
    })
    await append(doc.docId, 'edit', { minutesAgo: 1 })

    const rows = await searchActivity(doc.docId, { query: 'pricing' })
    expect(rows).toHaveLength(1)
    expect((rows[0]!.metadata as { commentId: string }).commentId).toBe('c1')
  })

  it('matches `query` against user_name', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit', { userName: 'Alice', minutesAgo: 5 })
    await append(doc.docId, 'edit', { userName: 'Bob', minutesAgo: 1 })

    const rows = await searchActivity(doc.docId, { query: 'alice' })
    expect(rows.map(r => r.userName)).toEqual(['Alice'])
  })

  it('is case-insensitive on the `query` match', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'comment.added', {
      metadata: { kind: 'comment.added', commentId: 'c1', bodyPreview: 'PRICING MODEL' }
    })
    const rows = await searchActivity(doc.docId, { query: 'pricing' })
    expect(rows).toHaveLength(1)
  })

  it('combines multiple filters multiplicatively (AND, not OR)', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit', { userName: 'Alice', minutesAgo: 1 })
    await append(doc.docId, 'comment.added', {
      userName: 'Alice',
      metadata: { kind: 'comment.added', commentId: 'c1', bodyPreview: 'note' },
      minutesAgo: 10
    })
    await append(doc.docId, 'edit', { userName: 'Bob', minutesAgo: 5 })

    const rows = await searchActivity(doc.docId, {
      actions: ['edit'],
      query: 'alice'
    })
    // Both filters must match — only the Alice/edit row qualifies.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.userName).toBe('Alice')
    expect(rows[0]!.action).toBe('edit')
  })

  it('honours the supplied `limit`, defaulting to 20 and capping at 50', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    for (let i = 0; i < 30; i++) {
      await append(doc.docId, 'edit', { minutesAgo: 30 - i })
    }
    expect(await searchActivity(doc.docId)).toHaveLength(20) // default
    expect(await searchActivity(doc.docId, { limit: 5 })).toHaveLength(5)
    expect(await searchActivity(doc.docId, { limit: 200 })).toHaveLength(30) // clamped to 50, but only 30 exist
  })

  it('is doc-scoped — rows from other docs are not returned', async () => {
    const u = await createUser()
    const docA = await createDoc({ ownerId: u.id })
    const docB = await createDoc({ ownerId: u.id })
    await append(docA.docId, 'edit', { userName: 'A-user' })
    await append(docB.docId, 'edit', { userName: 'B-user' })

    const aRows = await searchActivity(docA.docId)
    expect(aRows).toHaveLength(1)
    expect(aRows[0]!.userName).toBe('A-user')
  })

  it('returns [] when no rows match', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit')
    expect(await searchActivity(doc.docId, { query: 'definitely-not-in-the-data' })).toEqual([])
  })

  it('returns [] for an unknown docId', async () => {
    expect(await searchActivity('does-not-exist')).toEqual([])
  })

  it('treats blank `query` as no filter', async () => {
    // The handler trims input; the repo treats empty/whitespace as
    // "no query". Assert: passing `   ` matches everything, not nothing.
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit')
    await append(doc.docId, 'theme.changed', { metadata: { kind: 'theme.changed' } })
    expect(await searchActivity(doc.docId, { query: '   ' })).toHaveLength(2)
    expect(await searchActivity(doc.docId, { query: '' })).toHaveLength(2)
  })

  it('returns the attribution shape without any avatar field', async () => {
    // Avatars are generated client-side from `userId`; the row carries
    // no avatar URL. Pre-feature rows / AI rows / deleted-user rows
    // legitimately have a null user_id.
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await append(doc.docId, 'edit', { userName: 'Alice' })
    const rows = await searchActivity(doc.docId)
    expect(rows[0]).toMatchObject({
      userName: 'Alice',
      userId: null
    })
    expect(rows[0]).not.toHaveProperty('avatarUrl')
  })
})
