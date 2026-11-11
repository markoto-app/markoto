import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser } from '../integration/setup/fixtures'
import { loadInactiveAnonymousDocs, parseInactiveDocTtlDays } from '../../server/utils/documents/inactiveDocSweep'

// Candidate query of the inactive-doc sweep: anonymous docs (no owner, no
// workspace) inactive for the TTL (default 30 days) whose
// `sweep_not_before` floor has passed.

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-12-01T12:00:00Z')

async function setActivity(docId: string, lastActive: Date, sweepNotBefore: Date | null = null): Promise<void> {
  await testDb().query('UPDATE documents SET last_active = $2, sweep_not_before = $3 WHERE doc_id = $1', [docId, lastActive, sweepNotBefore])
}

async function candidates(ttlDays = 30, now = NOW): Promise<string[]> {
  return (await loadInactiveAnonymousDocs(ttlDays, now)).map(r => r.docId).sort()
}

describe('parseInactiveDocTtlDays', () => {
  it('accepts positive integers only', () => {
    expect(parseInactiveDocTtlDays(30)).toBe(30)
    expect(parseInactiveDocTtlDays('45')).toBe(45)
    expect(parseInactiveDocTtlDays('0')).toBe(0)
    expect(parseInactiveDocTtlDays('-3')).toBe(0)
    expect(parseInactiveDocTtlDays('2.5')).toBe(0)
    expect(parseInactiveDocTtlDays(undefined)).toBe(0)
  })
})

describe('loadInactiveAnonymousDocs', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('picks anonymous docs past 30 days of inactivity, never owned or workspace docs', async () => {
    const owner = await createUser()
    const stale = await createDoc({ docId: 'anon-stale' })
    const fresh = await createDoc({ docId: 'anon-fresh' })
    const owned = await createDoc({ docId: 'owned-stale', ownerId: owner.id })
    await setActivity(stale.docId, new Date(NOW.getTime() - 31 * DAY))
    await setActivity(fresh.docId, new Date(NOW.getTime() - 29 * DAY))
    await setActivity(owned.docId, new Date(NOW.getTime() - 400 * DAY))
    expect(await candidates()).toEqual(['anon-stale'])
  })

  it('respects the sweep_not_before floor', async () => {
    const doc = await createDoc({ docId: 'anon-floored' })
    await setActivity(doc.docId, new Date(NOW.getTime() - 100 * DAY), new Date(NOW.getTime() + DAY))
    expect(await candidates()).toEqual([])
    expect(await candidates(30, new Date(NOW.getTime() + 2 * DAY))).toEqual(['anon-floored'])
  })

  it('TTL 0 disables the sweep', async () => {
    const doc = await createDoc({ docId: 'anon-old' })
    await setActivity(doc.docId, new Date(NOW.getTime() - 999 * DAY))
    expect(await candidates(0)).toEqual([])
  })
})
